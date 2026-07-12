// Babbel Docs frontend: ProseMirror editor synced to a Google Doc.
//
// The Google Doc is the database: a `babel:meta` tab holds the canonical block
// model (JSON: languages, API key, usage, per-language content + pending
// flags); one tab per language holds the rendered document, with named ranges
// carrying block ids. This client polls the Drive file version (~2Hz), pulls
// the doc on change, merges edits (from other clients or from people typing
// directly in Google Docs), translates changed sentences with Claude, and
// writes results back. Translation work is locked via `[babel-lock]` Drive
// comments so concurrent clients don't translate the same block twice; human
// comments are left alone.

import {
  EditorState, Plugin, PluginKey, TextSelection,
  EditorView, Decoration, DecorationSet,
  Schema, DOMParser as PMDOMParser, DOMSerializer, Slice,
  MarkdownSerializer, MarkdownParser, defaultMarkdownSerializer, defaultMarkdownParser, markdownit,
  basicSchema, addListNodes, splitListItem, liftListItem, sinkListItem, wrapInList as pmWrapInList,
  keymap, baseKeymap, toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode,
  history as pmHistory, undo, redo,
  inputRules, wrappingInputRule, textblockTypeInputRule, undoInputRule,
  dropCursor, gapCursor,
} from "./vendor/prosemirror.js";

import * as G from "./gdocs.js";
import * as D from "./docmodel.js";
import * as T from "./translate.js";
import {
  LANGUAGE_CATALOG, newId, escapeHtml, sanitizeInlineHtml, stripTags,
  mergeBlocks, renderBlocks, blockContext,
} from "./core.js";

// --- Schema -----------------------------------------------------------------

const withId = (spec) => ({ ...spec, attrs: { ...(spec.attrs || {}), id: { default: null } } });

// A list item is one paragraph optionally followed by nested lists.
let nodes = addListNodes(basicSchema.spec.nodes, "paragraph (bullet_list | ordered_list)*", "block");
nodes = nodes.remove("image").remove("horizontal_rule");
nodes = nodes.update("blockquote", { ...nodes.get("blockquote"), content: "paragraph+" });
for (const name of ["paragraph", "heading", "code_block", "list_item"]) {
  nodes = nodes.update(name, withId(nodes.get(name)));
}

const marks = basicSchema.spec.marks
  .addToEnd("underline", {
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    toDOM: () => ["u", 0],
  })
  .addToEnd("strikethrough", {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }],
    toDOM: () => ["s", 0],
  });

const schema = new Schema({ nodes, marks });
const serializer = DOMSerializer.fromSchema(schema);
const pmParser = PMDOMParser.fromSchema(schema);

// --- Markdown conversion ------------------------------------------------------

const mdSerializer = new MarkdownSerializer(
  { ...defaultMarkdownSerializer.nodes },
  {
    ...defaultMarkdownSerializer.marks,
    underline: { open: "<u>", close: "</u>", mixable: true, expelEnclosingWhitespace: true },
    strikethrough: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  },
);

const mdTokens = { ...defaultMarkdownParser.tokens, s: { mark: "strikethrough" } };
delete mdTokens.hr;
delete mdTokens.image;
const mdParser = new MarkdownParser(schema, markdownit({ html: false }).disable(["hr", "image"]), mdTokens);

// --- Flat blocks <-> ProseMirror doc -----------------------------------------

function inlineHTML(node) {
  const div = document.createElement("div");
  div.appendChild(serializer.serializeFragment(node.content));
  return div.innerHTML;
}

function parseInline(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return pmParser.parseSlice(div, { preserveWhitespace: true }).content;
}

function docToBlocks(doc) {
  const out = [];
  const pushList = (listNode, indent) => {
    const kind = listNode.type.name === "ordered_list" ? "ordered" : "bullet";
    listNode.forEach((item) => {
      let para = null;
      const sublists = [];
      item.forEach((child) => {
        if (child.type.name === "paragraph" && !para) para = child;
        else if (child.type.name === "bullet_list" || child.type.name === "ordered_list") sublists.push(child);
      });
      out.push({
        id: item.attrs.id, type: "list_item", attrs: { list: kind, indent },
        html: para ? inlineHTML(para) : "",
      });
      for (const sub of sublists) pushList(sub, indent + 1);
    });
  };
  doc.forEach((node) => {
    const t = node.type.name;
    if (t === "paragraph") {
      out.push({ id: node.attrs.id, type: "paragraph", attrs: {}, html: inlineHTML(node) });
    } else if (t === "heading") {
      out.push({ id: node.attrs.id, type: "heading", attrs: { level: node.attrs.level }, html: inlineHTML(node) });
    } else if (t === "code_block") {
      out.push({ id: node.attrs.id, type: "code", attrs: {}, html: escapeHtml(node.textContent) });
    } else if (t === "blockquote") {
      node.forEach((p) => out.push({ id: p.attrs.id, type: "blockquote", attrs: {}, html: inlineHTML(p) }));
    } else if (t === "bullet_list" || t === "ordered_list") {
      pushList(node, 0);
    }
  });
  return out;
}

// Rebuild nested list nodes from a run of consecutive list_item blocks.
function buildLists(run) {
  let i = 0;
  const build = (depth) => {
    const kind = run[i].kind;
    const items = [];
    while (i < run.length && run[i].indent >= depth) {
      if (run[i].indent > depth) {
        if (!items.length) { run[i].indent = depth; continue; }
        items[items.length - 1].content.push(build(depth + 1));
        continue;
      }
      if (run[i].kind !== kind) break;
      const b = run[i++];
      items.push({ id: b.id, content: [schema.node("paragraph", { id: b.id }, parseInline(b.html))] });
    }
    return schema.node(kind === "ordered" ? "ordered_list" : "bullet_list", null,
      items.map((it) => schema.node("list_item", { id: it.id }, it.content)));
  };
  const lists = [];
  while (i < run.length) { run[i].indent = 0; lists.push(build(0)); }
  return lists;
}

function blocksToDoc(blocks) {
  const children = [];
  let quote = null;
  const flushQuote = () => {
    if (quote) { children.push(schema.node("blockquote", null, quote)); quote = null; }
  };

  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "list_item") {
      flushQuote();
      const run = [];
      while (i < blocks.length && blocks[i].type === "list_item") {
        const rb = blocks[i++];
        run.push({
          id: rb.id, html: rb.html,
          kind: rb.attrs?.list === "ordered" ? "ordered" : "bullet",
          indent: Math.max(Math.floor(rb.attrs?.indent) || 0, 0),
        });
      }
      children.push(...buildLists(run));
      continue;
    }
    i++;
    if (b.type === "blockquote") {
      quote = quote || [];
      quote.push(schema.node("paragraph", { id: b.id }, parseInline(b.html)));
      continue;
    }
    flushQuote();
    if (b.type === "heading") {
      const level = Math.min(Math.max(b.attrs?.level || 1, 1), 3);
      children.push(schema.node("heading", { id: b.id, level }, parseInline(b.html)));
    } else if (b.type === "code") {
      const div = document.createElement("div");
      div.innerHTML = b.html || "";
      const text = div.textContent;
      children.push(schema.node("code_block", { id: b.id }, text ? [schema.text(text)] : []));
    } else {
      children.push(schema.node("paragraph", { id: b.id }, parseInline(b.html)));
    }
  }
  flushQuote();
  if (!children.length) children.push(schema.node("paragraph", { id: newId() }));
  return schema.node("doc", null, children);
}

// --- Plugins ------------------------------------------------------------------

const ID_TYPES = new Set(["paragraph", "heading", "code_block", "list_item"]);

const idPlugin = new Plugin({
  appendTransaction(transactions, oldState, state) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const seen = new Set();
    let tr = null;
    state.doc.descendants((node, pos) => {
      if (!ID_TYPES.has(node.type.name)) return true;
      const inItem = node.type.name === "paragraph" &&
        state.doc.resolve(pos).parent.type.name === "list_item";
      if (inItem) return false;
      if (node.attrs.id == null || seen.has(node.attrs.id)) {
        let id = null;
        if (node.type.name === "list_item") {
          const childId = node.firstChild?.attrs?.id;
          if (childId && !seen.has(childId)) id = childId;
        }
        id = id || newId();
        seen.add(id);
        tr = (tr || state.tr).setNodeMarkup(pos, null, { ...node.attrs, id });
      } else {
        seen.add(node.attrs.id);
      }
      return true;
    });
    return tr;
  },
});

const pendingKey = new PluginKey("pending");
const pendingPlugin = new Plugin({
  key: pendingKey,
  state: {
    init: () => new Map(),
    apply: (tr, value) => tr.getMeta(pendingKey) || value,
  },
  props: {
    decorations(state) {
      const pending = pendingKey.getState(state);
      if (!pending || ![...pending.values()].some(Boolean)) return null;
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (!ID_TYPES.has(node.type.name)) return true;
        const inItem = node.type.name === "paragraph" &&
          state.doc.resolve(pos).parent.type.name === "list_item";
        if (!inItem && pending.get(node.attrs.id)) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "pending" }));
        }
        return true;
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

function buildInputRules() {
  return inputRules({ rules: [
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (m) => ({ level: m[1].length })),
    wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
  ]});
}

function buildKeymap() {
  return keymap({
    "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-u": toggleMark(schema.marks.underline),
    "Mod-`": toggleMark(schema.marks.code),
    "Backspace": undoInputRule,
    "Enter": splitListItem(schema.nodes.list_item),
    "Mod-Enter": exitCode,
    "Tab": sinkListItem(schema.nodes.list_item),
    "Shift-Tab": liftListItem(schema.nodes.list_item),
    "Mod-]": sinkListItem(schema.nodes.list_item),
    "Mod-[": liftListItem(schema.nodes.list_item),
  });
}

// --- App state ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  landing: $("view-landing"), setup: $("view-setup"), editorView: $("view-editor"),
  signIn: $("sign-in"), landingOpen: $("landing-open"), landingUrl: $("landing-url"),
  recentList: $("recent-list"), landingStatus: $("landing-status"),
  setupLang: $("setup-lang"), setupKey: $("setup-key"), setupGo: $("setup-go"),
  setupStatus: $("setup-status"), setupDocName: $("setup-doc-name"),
  docName: $("doc-name"), openInDocs: $("open-in-docs"), share: $("share"), openOther: $("open-other"),
  cost: $("cost"), translating: $("translating"), syncDot: $("sync-dot"), syncText: $("sync-text"),
  langSelect: $("lang-select"), addLang: $("add-lang"),
  addLangPanel: $("add-lang-panel"), addLangInput: $("add-lang-input"),
  addLangConfirm: $("add-lang-confirm"), addLangCancel: $("add-lang-cancel"),
  langCatalog: $("lang-catalog"),
  editorMount: $("editor"), editorScroll: $("editor-scroll"),
  toast: $("toast"), toolbar: $("toolbar"), readonly: $("readonly-note"),
};

let view = null;
let docId = null;
let docName = "";
let canEdit = false;
let lang = null;
let model = null;              // parsed babel:meta JSON — the canonical document model
let docSnapshot = null;        // last fetched documents.get result
let lastVersion = null;        // Drive file version we've already pulled
let lastRevision = null;       // Docs revisionId we've already pulled
let pollTick = 0;
let lastReceived = new Map();  // block id -> {html, sig} last rendered for our lang
let sendTimer = null;
let applyingRemote = false;
let skippedRemote = false;
let pollTimer = null;
let writeChain = Promise.resolve();
let writing = false;
const clientId = newId();
const translateTimers = new Map(); // blockId -> timeout
const heldLocks = new Map();       // blockId -> commentId

const sigOf = (b) => `${b.type}|${JSON.stringify(b.attrs || {})}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const langName = (code) => model?.languages.find((l) => l.code === code)?.name || code;
const langTab = (code) => {
  const entry = model?.languages.find((l) => l.code === code);
  return entry && docSnapshot ? D.tabById(docSnapshot, entry.tabId) : null;
};

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = isError ? "error" : "";
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}

function setSync(state, text) {
  els.syncDot.className = `dot ${state}`;
  els.syncText.textContent = text;
}

function showView(name) {
  els.landing.hidden = name !== "landing";
  els.setup.hidden = name !== "setup";
  els.editorView.hidden = name !== "editor";
}

function updateCost() {
  const u = model?.usage;
  if (!u || !u.calls) { els.cost.hidden = true; return; }
  els.cost.hidden = false;
  els.cost.textContent = `$${u.cost_usd.toFixed(4)}`;
  els.cost.title = `Claude translation cost for this document\n` +
    `${u.calls} API calls · ${u.input_tokens.toLocaleString()} input / ` +
    `${u.output_tokens.toLocaleString()} output tokens`;
}

function updateTranslating() {
  els.translating.hidden = !model?.blocks.some((b) => b.pending?.length);
}

// --- Editor ----------------------------------------------------------------------

function createEditor() {
  const state = EditorState.create({
    schema,
    plugins: [
      buildInputRules(), buildKeymap(), keymap(baseKeymap),
      dropCursor(), gapCursor(), pmHistory(),
      idPlugin, pendingPlugin,
    ],
  });
  view = new EditorView(els.editorMount, {
    state,
    editable: () => canEdit,
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      view.updateState(newState);
      updateToolbar();
      if (tr.docChanged && !applyingRemote) scheduleSend();
    },
  });
  updateToolbar();
}

function scheduleSend() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendUpdate, 400);
}

const hasUnsentChanges = () => sendTimer !== null;

function flushPendingSend() {
  if (sendTimer) { clearTimeout(sendTimer); sendUpdate(); }
}

function sendUpdate() {
  sendTimer = null;
  if (!view || !model || !canEdit) return;
  const blocks = docToBlocks(view.state.doc);
  let changed = false;
  const payload = blocks.map((b) => {
    const prev = lastReceived.get(b.id);
    const sig = sigOf(b);
    if (prev && prev.html === b.html) {
      // Text untouched: omit html so the merge keeps all translations, but
      // type/attrs changes (heading toggle, list indent) still count as edits.
      if (prev.sig !== sig) changed = true;
      prev.sig = sig;
      return { id: b.id, type: b.type, attrs: b.attrs };
    }
    changed = true;
    lastReceived.set(b.id, { html: b.html, sig });
    return b;
  });
  const removed = lastReceived.size !== blocks.length;
  if (!(changed || removed || skippedRemote)) return;
  skippedRemote = false;
  const ids = new Set(blocks.map((b) => b.id));
  for (const id of [...lastReceived.keys()]) if (!ids.has(id)) lastReceived.delete(id);

  const beforeOrder = model.blocks.map((b) => b.id).join(",");
  const beforeSigs = new Map(model.blocks.map((b) => [b.id, sigOf(b)]));
  const dirty = mergeBlocks(model, payload, lang);
  // Type/attr changes (heading toggle, list indent) and reorders show in every
  // language tab, so they force a full rewrite of all of them; plain text
  // edits only rewrite the changed blocks in our own tab.
  const structureChanged =
    model.blocks.map((b) => b.id).join(",") !== beforeOrder ||
    model.blocks.some((b) => beforeSigs.has(b.id) && beforeSigs.get(b.id) !== sigOf(b));
  applyLocalModel();
  const plans = {};
  if (structureChanged) for (const l of model.languages) plans[l.code] = "full";
  else plans[lang] = new Set(dirty);
  queueWrite(plans, true);
  for (const id of dirty) scheduleTranslate(id);
}

function applyLocalModel() {
  // Refresh pending highlights + cost from the local model without touching text.
  if (!view) return;
  const rendered = renderBlocks(model, lang);
  const pending = new Map(rendered.map((b) => [b.id, !!b.pending]));
  view.dispatch(view.state.tr.setMeta(pendingKey, pending));
  updateTranslating();
  updateCost();
}

function applyRemote(blocks) {
  if (!view) return;
  if (hasUnsentChanges()) { skippedRemote = true; return; }

  lastReceived = new Map(blocks.map((b) => [b.id, { html: b.html, sig: sigOf(b) }]));
  const pending = new Map(blocks.map((b) => [b.id, !!b.pending]));
  const newDoc = blocksToDoc(blocks);

  applyingRemote = true;
  try {
    if (!newDoc.eq(view.state.doc)) {
      const { head } = view.state.selection;
      const $head = view.state.doc.resolve(head);
      let anchorId = null, offset = 0;
      for (let d = $head.depth; d > 0; d--) {
        const node = $head.node(d);
        if (ID_TYPES.has(node.type.name) && node.attrs.id) {
          anchorId = node.attrs.id;
          offset = head - $head.start(d);
          break;
        }
      }
      let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
      if (anchorId) {
        let target = null;
        tr.doc.descendants((node, pos) => {
          if (target == null && ID_TYPES.has(node.type.name) && node.attrs.id === anchorId) {
            target = Math.min(pos + 1 + offset, pos + node.nodeSize - 1);
          }
          return target == null;
        });
        if (target != null) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
      }
      view.dispatch(tr.setMeta("addToHistory", false).setMeta(pendingKey, pending));
    } else {
      view.dispatch(view.state.tr.setMeta(pendingKey, pending));
    }
  } finally {
    applyingRemote = false;
  }
  updateTranslating();
}

// --- Toolbar -----------------------------------------------------------------------

function markActive(type) {
  const { from, $from, to, empty } = view.state.selection;
  if (empty) return !!type.isInSet(view.state.storedMarks || $from.marks());
  return view.state.doc.rangeHasMark(from, to, type);
}

function blockActive(type, attrs = {}) {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === type && Object.entries(attrs).every(([k, v]) => node.attrs[k] === v)) return true;
  }
  return false;
}

const keepId = (attrs) => (node) => ({ ...attrs, id: node.attrs.id });

function toggleLink() {
  const type = schema.marks.link;
  if (markActive(type)) return toggleMark(type)(view.state, view.dispatch);
  const href = prompt("Link URL (https://…):", "https://");
  if (!href || !/^https?:\/\//.test(href)) return;
  toggleMark(type, { href })(view.state, view.dispatch);
}

function toggleList(listType) {
  if (blockActive(listType)) return liftListItem(schema.nodes.list_item)(view.state, view.dispatch);
  return pmWrapInList(listType)(view.state, view.dispatch);
}

const commands = {
  bold: () => toggleMark(schema.marks.strong)(view.state, view.dispatch),
  italic: () => toggleMark(schema.marks.em)(view.state, view.dispatch),
  underline: () => toggleMark(schema.marks.underline)(view.state, view.dispatch),
  strike: () => toggleMark(schema.marks.strikethrough)(view.state, view.dispatch),
  code: () => toggleMark(schema.marks.code)(view.state, view.dispatch),
  link: toggleLink,
  paragraph: () => setBlockType(schema.nodes.paragraph, keepId({}))(view.state, view.dispatch),
  h1: () => setBlockType(schema.nodes.heading, keepId({ level: 1 }))(view.state, view.dispatch),
  h2: () => setBlockType(schema.nodes.heading, keepId({ level: 2 }))(view.state, view.dispatch),
  h3: () => setBlockType(schema.nodes.heading, keepId({ level: 3 }))(view.state, view.dispatch),
  bullet: () => toggleList(schema.nodes.bullet_list),
  ordered: () => toggleList(schema.nodes.ordered_list),
  quote: () => blockActive(schema.nodes.blockquote)
    ? lift(view.state, view.dispatch)
    : wrapIn(schema.nodes.blockquote)(view.state, view.dispatch),
  codeblock: () => setBlockType(schema.nodes.code_block, keepId({}))(view.state, view.dispatch),
  undo: () => undo(view.state, view.dispatch),
  redo: () => redo(view.state, view.dispatch),
  copymd: copyMarkdown,
  pastemd: pasteMarkdown,
};

async function copyMarkdown() {
  const md = mdSerializer.serialize(view.state.doc);
  try {
    await navigator.clipboard.writeText(md);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied document as Markdown");
}

function insertMarkdown(text) {
  const parsed = mdParser.parse(text);
  view.dispatch(view.state.tr.replaceSelection(new Slice(parsed.content, 0, 0)).scrollIntoView());
}

async function pasteMarkdown() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast("Clipboard read was blocked by the browser — allow clipboard access and retry", true);
    return;
  }
  if (!text?.trim()) { toast("Clipboard is empty", true); return; }
  try {
    insertMarkdown(text);
  } catch (err) {
    toast(`Couldn't parse clipboard as Markdown: ${err.message}`, true);
  }
}

function updateToolbar() {
  if (!view) return;
  const active = {
    bold: markActive(schema.marks.strong),
    italic: markActive(schema.marks.em),
    underline: markActive(schema.marks.underline),
    strike: markActive(schema.marks.strikethrough),
    code: markActive(schema.marks.code),
    link: markActive(schema.marks.link),
    h1: blockActive(schema.nodes.heading, { level: 1 }),
    h2: blockActive(schema.nodes.heading, { level: 2 }),
    h3: blockActive(schema.nodes.heading, { level: 3 }),
    bullet: blockActive(schema.nodes.bullet_list),
    ordered: blockActive(schema.nodes.ordered_list),
    quote: blockActive(schema.nodes.blockquote),
    codeblock: blockActive(schema.nodes.code_block),
  };
  for (const btn of els.toolbar.querySelectorAll("button[data-cmd]")) {
    btn.classList.toggle("active", !!active[btn.dataset.cmd]);
  }
}

els.toolbar.addEventListener("mousedown", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  e.preventDefault();
  commands[btn.dataset.cmd]?.();
  view?.focus();
});

// --- Google Docs sync ---------------------------------------------------------------

async function refreshSnapshot() {
  docSnapshot = await G.getDocument(docId);
  lastRevision = docSnapshot.revisionId;
  const meta = await G.getFileMeta(docId);
  lastVersion = meta.version;
  docName = meta.name;
  els.docName.textContent = docName;
}

function queueWrite(tabPlans, metaChanged) {
  // tabPlans: {langCode: "full" | Set(blockIds)}; serialized so concurrent
  // edits/translations never compute indices against a stale snapshot.
  writeChain = writeChain.then(async () => {
    if (!model) return;
    writing = true;
    setSync("busy", "Saving…");
    try {
      const requests = [];
      for (const [code, plan] of Object.entries(tabPlans || {})) {
        const tab = langTab(code);
        if (!tab) continue;
        const rendered = renderBlocks(model, code);
        if (plan === "full") {
          requests.push(...D.fullTabRewriteRequests(tab, rendered));
        } else {
          const { spans } = D.parseLanguageTab(tab);
          const targets = rendered
            .filter((b) => plan.has(b.id) && spans.has(b.id))
            .sort((a, b) => spans.get(b.id)[0] - spans.get(a.id)[0]); // bottom-up
          const missing = [...plan].some((id) => !spans.get(id) && rendered.some((b) => b.id === id));
          if (missing) {
            requests.push(...D.fullTabRewriteRequests(tab, rendered));
          } else {
            for (const b of targets) {
              requests.push(...D.singleBlockRewriteRequests(tab, b, spans.get(b.id)));
            }
          }
        }
      }
      if (metaChanged) {
        const metaTab = D.findMetaTab(docSnapshot);
        if (metaTab) requests.push(...D.metaRewriteRequests(metaTab, model));
      }
      if (requests.length) {
        await G.batchUpdate(docId, requests);
        await refreshSnapshot();
      }
      setSync("on", "Synced");
    } catch (err) {
      console.error(err);
      setSync("off", "Save failed");
      toast(`Save failed: ${err.message}`, true);
      // Re-pull on next poll so we converge with whatever is in the doc.
      lastVersion = null;
    } finally {
      writing = false;
    }
  });
  return writeChain;
}

async function pullDoc() {
  const doc = await G.getDocument(docId);
  docSnapshot = doc;
  lastRevision = doc.revisionId;
  const metaTab = D.findMetaTab(doc);
  const meta = metaTab ? D.parseMeta(metaTab) : null;
  if (!meta) { enterSetup(doc); return; }
  model = meta;
  model.usage = model.usage || { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 };

  if (!model.languages.some((l) => l.code === lang)) {
    lang = model.languages[0]?.code;
    updateLangSelect();
  }

  // Detect edits made directly in Google Docs (or half-written by a client
  // that died): any language tab whose text differs from the model.
  const editsByLang = new Map();
  for (const l of model.languages) {
    const tab = D.tabById(doc, l.tabId);
    if (!tab) continue;
    const parsed = D.parseLanguageTab(tab);
    const rendered = renderBlocks(model, l.code);
    const renderedById = new Map(rendered.map((b) => [b.id, b]));
    let differs = parsed.blocks.length !== rendered.length || parsed.blocks.some((b) => !b.id);
    const incoming = parsed.blocks.map((b, i) => {
      const id = b.id || newId();
      const known = b.id ? renderedById.get(b.id) : null;
      if (known && known.html === b.html) {
        if (rendered[i]?.id !== b.id || sigOf(known) !== sigOf(b)) differs = true;
        return { id, type: b.type, attrs: b.attrs };
      }
      differs = true;
      return { id, type: b.type, attrs: b.attrs, html: b.html };
    });
    if (differs) editsByLang.set(l.code, incoming);
  }

  const dirtyIds = [];
  for (const [code, incoming] of editsByLang) {
    dirtyIds.push(...mergeBlocks(model, incoming, code));
  }
  if (editsByLang.size && canEdit) {
    // Normalize every language tab: external edits may have reordered or
    // retyped blocks, which must be reflected everywhere, and the edited tab
    // needs its named ranges re-registered.
    const rewrites = {};
    for (const l of model.languages) rewrites[l.code] = "full";
    queueWrite(rewrites, true);
    for (const id of dirtyIds) scheduleTranslate(id);
  }
  // Blocks still pending from an earlier session: pick them up (with locks).
  if (canEdit && model.apiKey) {
    for (const b of model.blocks) if (b.pending?.length) scheduleTranslate(b.id);
  }

  applyRemote(renderBlocks(model, lang));
  updateLangSelect();
  updateCost();
  updateTranslating();
}

async function pollLoop() {
  clearTimeout(pollTimer);
  try {
    if (!writing && model) {
      // Cheap Drive-version check every tick; every 4th tick also probe the
      // Docs revisionId, since Drive's version field can lag content changes.
      const meta = await G.getFileMeta(docId);
      let changed = meta.version !== lastVersion;
      if (!changed && pollTick % 4 === 3) {
        changed = (await G.getRevisionId(docId)) !== lastRevision;
      }
      if (changed) {
        docName = meta.name;
        els.docName.textContent = docName;
        await pullDoc();
        lastVersion = meta.version; // commit only after a successful pull
      }
      setSync("on", "Synced");
    }
  } catch (err) {
    console.error(err);
    setSync("off", /sign|popup|401/i.test(err.message) ? "Sign-in expired — reload" : "Reconnecting…");
  }
  pollTick += 1;
  pollTimer = setTimeout(pollLoop, 500);
}

// Pull immediately when the window regains focus, so switching between two
// windows feels instant.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && docId && model) pollLoop();
});

// --- Locks (Drive comments) -----------------------------------------------------------

const LOCK_PREFIX = "[babel-lock]";
const LOCK_TTL_MS = 2 * 60 * 1000;

function parseLock(comment) {
  if (!comment.content?.startsWith(LOCK_PREFIX)) return null;
  try {
    const data = JSON.parse(comment.content.slice(LOCK_PREFIX.length));
    return { ...data, commentId: comment.id, createdTime: Date.parse(comment.createdTime) };
  } catch {
    return null;
  }
}

async function acquireLock(blockId) {
  // Create our lock comment, then look: if someone else's fresh lock on the
  // same block predates ours, back off. Human comments are never touched.
  const body = LOCK_PREFIX + JSON.stringify({ b: blockId, c: clientId, t: Date.now() });
  const created = await G.createComment(docId, body);
  const mineTime = Date.parse(created.createdTime);
  const comments = await G.listComments(docId);
  const locks = comments.map(parseLock).filter((l) => l && l.b === blockId);
  for (const l of locks) {
    const age = Date.now() - l.createdTime;
    if (l.c !== clientId && age < LOCK_TTL_MS && l.createdTime <= mineTime && l.commentId !== created.id) {
      await G.deleteComment(docId, created.id);
      return false;
    }
    if (l.c === clientId && l.commentId !== created.id) {
      await G.deleteComment(docId, l.commentId); // our own stale lock
    }
  }
  heldLocks.set(blockId, created.id);
  return true;
}

async function releaseLock(blockId) {
  const commentId = heldLocks.get(blockId);
  heldLocks.delete(blockId);
  if (commentId) await G.deleteComment(docId, commentId).catch(() => {});
}

// --- Translation ------------------------------------------------------------------------

function scheduleTranslate(blockId) {
  if (!canEdit) return;
  if (!model?.apiKey) { toast("No Anthropic API key in babel:meta — translations are paused", true); return; }
  clearTimeout(translateTimers.get(blockId));
  translateTimers.set(blockId, setTimeout(() => {
    translateTimers.delete(blockId);
    translateBlock(blockId).catch((err) => {
      console.error(err);
      toast(`Translation failed: ${err.message}`, true);
    });
  }, 1000));
}

async function translateBlock(blockId) {
  const block = model?.blocks.find((b) => b.id === blockId);
  if (!block || !block.pending?.length) return;
  if (!(await acquireLock(blockId))) return; // another client is on it
  try {
    const source = block.source;
    const sourceHtml = block.content[source];
    const targets = [...block.pending];
    const context = blockContext(model, blockId, source);
    const spent = { input: 0, output: 0, calls: 0 };
    const cfg = { apiKey: model.apiKey, model: model.model || T.DEFAULT_MODEL };

    const results = await Promise.allSettled(targets.map((t) =>
      T.translateBlockTo(cfg, sourceHtml, block.prev_html, block.content[t],
        langName(source), langName(t), context, spent)));

    // Record cost even if the result ends up discarded below.
    model.usage.input_tokens += spent.input;
    model.usage.output_tokens += spent.output;
    model.usage.calls += spent.calls;
    model.usage.cost_usd += T.costOf(cfg.model, spent.input, spent.output);

    // Re-check: the block may have been re-edited meanwhile.
    const cur = model.blocks.find((b) => b.id === blockId);
    if (!cur || cur.content[cur.source] !== sourceHtml) {
      queueWrite({}, true);
      updateCost();
      return;
    }
    const errors = [];
    const changedTabs = {};
    targets.forEach((t, i) => {
      const r = results[i];
      if (r.status === "rejected") {
        errors.push(`${langName(t)}: ${r.reason?.message || r.reason}`);
      } else {
        cur.content[t] = sanitizeInlineHtml(r.value);
        cur.pending = (cur.pending || []).filter((p) => p !== t);
        changedTabs[t] = new Set([blockId]);
      }
    });
    if (!cur.pending?.length) delete cur.prev_html;
    queueWrite(changedTabs, true);
    if (lang !== cur.source) applyRemote(renderBlocks(model, lang));
    applyLocalModel();
    if (errors.length) toast(`Some translations failed and will retry on the next edit (${errors[0]})`, true);
  } finally {
    await releaseLock(blockId);
  }
}

// --- Languages ------------------------------------------------------------------------------

function updateLangSelect() {
  els.langSelect.innerHTML = "";
  for (const l of model?.languages || []) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    els.langSelect.appendChild(opt);
  }
  els.langSelect.value = lang;
}

els.langSelect.onchange = () => {
  flushPendingSend();
  lang = els.langSelect.value;
  localStorage.setItem(`babel-lang-${docId}`, lang);
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  history.replaceState(null, "", url);
  lastReceived = new Map();
  applyRemote(renderBlocks(model, lang));
};

els.addLang.onclick = () => {
  els.addLangPanel.hidden = !els.addLangPanel.hidden;
  if (!els.addLangPanel.hidden) {
    els.addLangInput.value = "";
    els.addLangInput.focus();
  }
};
els.addLangCancel.onclick = () => { els.addLangPanel.hidden = true; };
els.addLangConfirm.onclick = addLanguage;
els.addLangInput.onkeydown = (e) => { if (e.key === "Enter") addLanguage(); };

async function addLanguage() {
  const raw = els.addLangInput.value.trim();
  if (!raw || !model || !canEdit) return;
  const entry = LANGUAGE_CATALOG.find(
    (l) => l.name.toLowerCase() === raw.toLowerCase() || l.code === raw.toLowerCase());
  const code = entry?.code || raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8);
  const name = entry?.name || raw;
  if (!code || !name) return;
  if (model.languages.some((l) => l.code === code)) { toast("Language already added", true); return; }
  els.addLangPanel.hidden = true;
  toast(`Adding ${name}…`);

  const dirty = [];
  writeChain = writeChain.then(async () => {
    writing = true;
    try {
      const tabId = await G.addTab(docId, name);
      await refreshSnapshot();
      model.languages.push({ code, name, tabId });
      for (const b of model.blocks) {
        if (b.type === "code" || !stripTags(b.content[b.source] || "").trim()) {
          b.content[code] = b.content[b.source] || "";
        } else if (!(code in b.content)) {
          b.pending = b.pending || [];
          if (!b.pending.includes(code)) b.pending.push(code);
          dirty.push(b.id);
        }
      }
      const tab = D.tabById(docSnapshot, tabId);
      const requests = [
        ...D.fullTabRewriteRequests(tab, renderBlocks(model, code)),
        ...D.metaRewriteRequests(D.findMetaTab(docSnapshot), model),
      ];
      await G.batchUpdate(docId, requests);
      await refreshSnapshot();
    } finally {
      writing = false;
    }
  }).then(() => {
    updateLangSelect();
    applyLocalModel();
    toast(`Added ${name} — translating existing content…`);
    dirty.forEach((id, i) => setTimeout(() => scheduleTranslate(id), i * 400));
  }).catch((err) => {
    toast(`Couldn't add language: ${err.message}`, true);
  });
}

// --- Setup (no babel:meta tab yet) --------------------------------------------------------------

function enterSetup(doc) {
  clearTimeout(pollTimer);
  if (!canEdit) {
    showView("landing");
    els.landingStatus.textContent =
      "This document isn't set up for Babbel Docs yet, and you don't have edit access to set it up.";
    return;
  }
  showView("setup");
  els.setupDocName.textContent = docName || "this document";
  els.setupLang.value = els.setupLang.value || "English";
}

els.setupGo.onclick = async () => {
  const raw = els.setupLang.value.trim() || "English";
  const entry = LANGUAGE_CATALOG.find(
    (l) => l.name.toLowerCase() === raw.toLowerCase() || l.code === raw.toLowerCase());
  const code = entry?.code || raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8);
  const name = entry?.name || raw;
  const apiKey = els.setupKey.value.trim();
  if (!apiKey.startsWith("sk-ant-")) {
    els.setupStatus.textContent = "That doesn't look like an Anthropic API key (sk-ant-…).";
    return;
  }
  els.setupGo.disabled = true;
  els.setupStatus.textContent = "Checking API key…";
  try {
    await T.verifyApiKey(apiKey);
    els.setupStatus.textContent = "Setting up document tabs…";
    const doc = await G.getDocument(docId);
    const firstTab = D.flattenTabs(doc)[0];
    const parsed = D.parseLanguageTab(firstTab);
    const blocks = parsed.blocks.map((b) => ({
      id: b.id || newId(),
      type: b.type,
      attrs: b.attrs,
      content: { [code]: sanitizeInlineHtml(b.html) },
      source: code,
      pending: [],
    }));
    model = {
      babel: 1,
      model: T.DEFAULT_MODEL,
      apiKey,
      languages: [{ code, name, tabId: firstTab.tabProperties.tabId }],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 },
      blocks,
    };
    const metaTabId = await G.addTab(docId, D.META_TAB_TITLE);
    const fresh = await G.getDocument(docId);
    const langTabFresh = D.tabById(fresh, firstTab.tabProperties.tabId);
    const metaTabFresh = D.tabById(fresh, metaTabId);
    await G.batchUpdate(docId, [
      { updateDocumentTabProperties: {
        tabProperties: { tabId: firstTab.tabProperties.tabId, title: name }, fields: "title" } },
      ...D.fullTabRewriteRequests(langTabFresh, renderBlocks(model, code)),
      ...D.metaRewriteRequests(metaTabFresh, model),
    ]);
    lang = code;
    await enterEditor();
  } catch (err) {
    console.error(err);
    els.setupStatus.textContent = `Setup failed: ${err.message}`;
  } finally {
    els.setupGo.disabled = false;
  }
};

// --- Landing / boot ----------------------------------------------------------------------------------

function recentDocs() {
  try { return JSON.parse(localStorage.getItem("babel-recent") || "[]"); } catch { return []; }
}

function rememberDoc(id, name) {
  const list = recentDocs().filter((d) => d.id !== id);
  list.unshift({ id, name, at: Date.now() });
  localStorage.setItem("babel-recent", JSON.stringify(list.slice(0, 12)));
}

function renderRecent() {
  const docs = recentDocs();
  els.recentList.innerHTML = "";
  els.recentList.hidden = !docs.length;
  for (const d of docs) {
    const li = document.createElement("li");
    li.textContent = d.name || d.id;
    li.onclick = () => openDoc(d.id);
    els.recentList.appendChild(li);
  }
}

async function openDoc(id) {
  docId = id;
  els.landingStatus.textContent = "Opening document…";
  try {
    const meta = await G.getFileMeta(docId);
    docName = meta.name;
    canEdit = !!meta.capabilities?.canEdit;
    lastVersion = meta.version;
    rememberDoc(docId, docName);
    const url = new URL(location.href);
    url.searchParams.set("doc", docId);
    history.replaceState(null, "", url);
    lang = new URL(location.href).searchParams.get("lang") ||
      localStorage.getItem(`babel-lang-${docId}`) || null;
    await enterEditor();
  } catch (err) {
    console.error(err);
    els.landingStatus.textContent = `Couldn't open document: ${err.message}`;
  }
}

async function enterEditor() {
  showView("editor");
  els.docName.textContent = docName;
  els.openInDocs.href = `https://docs.google.com/document/d/${docId}/edit`;
  els.readonly.hidden = canEdit;
  if (!view) createEditor();
  lastReceived = new Map();
  await pullDoc();
  if (model) {
    if (!lang || !model.languages.some((l) => l.code === lang)) lang = model.languages[0]?.code;
    updateLangSelect();
    applyRemote(renderBlocks(model, lang));
    pollLoop();
  }
}

els.share.onclick = async () => {
  const url = `${location.origin}${location.pathname}?doc=${docId}&lang=${encodeURIComponent(lang)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied — anyone with access to the Google Doc can open it");
  } catch {
    prompt("Share this link:", url);
  }
};

els.landingOpen.onclick = () => {
  const id = G.extractDocId(els.landingUrl.value);
  if (!id) { els.landingStatus.textContent = "Paste a Google Docs URL (docs.google.com/document/d/…)"; return; }
  openDoc(id);
};
els.landingUrl.onkeydown = (e) => { if (e.key === "Enter") els.landingOpen.onclick(); };

function showLanding() {
  showView("landing");
  const signedIn = G.isSignedIn();
  els.signIn.hidden = signedIn;
  document.getElementById("landing-open-row").hidden = !signedIn;
  els.landingStatus.textContent = "";
  if (signedIn) renderRecent();
}

function openFromUrl() {
  const fromUrl = G.extractDocId(new URL(location.href).searchParams.get("doc") || "");
  if (fromUrl) openDoc(fromUrl);
  return !!fromUrl;
}

els.signIn.onclick = async () => {
  try {
    els.landingStatus.textContent = "Signing in…";
    await G.signIn();
    showLanding();
    openFromUrl();
  } catch (err) {
    els.landingStatus.textContent = `Sign-in failed: ${err.message}`;
  }
};

els.openOther.onclick = () => {
  // Leave the current document and go back to the landing page.
  clearTimeout(pollTimer);
  clearTimeout(sendTimer);
  sendTimer = null;
  for (const t of translateTimers.values()) clearTimeout(t);
  translateTimers.clear();
  model = null; docId = null; docSnapshot = null;
  lastVersion = null; lastRevision = null;
  lastReceived = new Map();
  const url = new URL(location.href);
  url.searchParams.delete("doc");
  url.searchParams.delete("lang");
  history.replaceState(null, "", url);
  showLanding();
};

(async function boot() {
  const datalist = document.getElementById("lang-catalog");
  datalist.innerHTML = LANGUAGE_CATALOG.map((l) => `<option value="${l.name}">${l.code}</option>`).join("");
  showView("landing");
  try {
    await G.initAuth();
    els.signIn.disabled = false;
  } catch (err) {
    els.landingStatus.textContent = err.message;
    return;
  }
  showLanding();
  // A token persisted from a previous window/session: skip the sign-in click.
  if (G.isSignedIn()) openFromUrl();
})();

window.babbel = { toMarkdown: () => mdSerializer.serialize(view.state.doc), insertMarkdown };
