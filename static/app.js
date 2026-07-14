// Babbel Docs frontend: the ProseMirror editor and UI shell. All syncing
// with the Google Doc (polling, writes, locks, translation, conflict merge,
// highlight state) lives in sync.js; this file converts between the editor
// document and flat blocks, renders marks, and wires the views.

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
import { verifyApiKey } from "./translate.js";
import { createEngine } from "./sync.js";
import { LANGUAGE_CATALOG, newId, escapeHtml } from "./core.js";

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

// Translation-state decorations. Input: Map(blockId -> mark) where mark is
//   {kind: "in"|"out", all: true}                  whole-block highlight
//   {kind, sents: [[s,e],...], ins: [offset,...]}  sentence-level highlight
// "in" (yellow) = incoming translation will replace this text; "out" (blue) =
// this text is being translated outward; ins = blank-space placeholders where
// newly added text will appear.
const pendingKey = new PluginKey("pending");

function gapWidget() {
  const el = document.createElement("span");
  el.className = "incoming-gap";
  el.textContent = "\u00a0\u00a0\u00a0";
  return el;
}

const pendingPlugin = new Plugin({
  key: pendingKey,
  state: {
    init: () => new Map(),
    apply: (tr, value) => tr.getMeta(pendingKey) || value,
  },
  props: {
    decorations(state) {
      const marks = pendingKey.getState(state);
      if (!marks || !marks.size) return null;
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (!ID_TYPES.has(node.type.name)) return true;
        const inItem = node.type.name === "paragraph" &&
          state.doc.resolve(pos).parent.type.name === "list_item";
        if (inItem) return false;
        const m = marks.get(node.attrs.id);
        if (m) {
          const cls = m.kind === "out" ? "outgoing"
            : m.kind === "editing" ? "editing"
            : m.kind === "merged" ? "merged"
            : "pending";
          if (m.all) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
          } else {
            // The text lives in the node itself, except list items, where it
            // lives in the first (paragraph) child.
            let textNode = node, textPos = pos;
            if (node.type.name === "list_item" && node.firstChild) {
              textNode = node.firstChild;
              textPos = pos + 1;
            }
            const base = textPos + 1;
            const max = textNode.content.size;
            for (const [s, e] of m.sents || []) {
              const a = Math.min(s, max), b = Math.min(e, max);
              if (b > a) decos.push(Decoration.inline(base + a, base + b, { class: cls }));
            }
            for (const off of m.ins || []) {
              decos.push(Decoration.widget(base + Math.min(off, max), gapWidget, { side: -1 }));
            }
          }
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
  reauth: $("reauth"),
  cost: $("cost"), translating: $("translating"), syncDot: $("sync-dot"), syncText: $("sync-text"),
  langSelect: $("lang-select"), addLang: $("add-lang"),
  addLangPanel: $("add-lang-panel"), addLangInput: $("add-lang-input"),
  addLangConfirm: $("add-lang-confirm"), addLangCancel: $("add-lang-cancel"),
  langCatalog: $("lang-catalog"),
  editorMount: $("editor"), editorScroll: $("editor-scroll"),
  toast: $("toast"), toolbar: $("toolbar"), readonly: $("readonly-note"),
};

let view = null;
let sendTimer = null;
let applyingRemote = false;

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

function updateCost(usage) {
  if (!usage || !usage.calls) { els.cost.hidden = true; return; }
  els.cost.hidden = false;
  els.cost.textContent = `$${usage.cost_usd.toFixed(4)}`;
  els.cost.title = `Claude translation cost for this document\n` +
    `${usage.calls} API calls · ${usage.input_tokens.toLocaleString()} input / ` +
    `${usage.output_tokens.toLocaleString()} output tokens`;
}

function renderLangSelect(languages, lang) {
  els.langSelect.innerHTML = "";
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    els.langSelect.appendChild(opt);
  }
  els.langSelect.value = lang;
}

// --- The sync engine ---------------------------------------------------------------

const engine = createEngine({
  onRender: (blocks, marks) => applyRemote(blocks, marks),
  onMarks: (marks) => {
    if (view) view.dispatch(view.state.tr.setMeta(pendingKey, marks));
  },
  onStatus: setSync,
  onUsage: updateCost,
  onLanguages: renderLangSelect,
  onTranslating: (b) => { els.translating.hidden = !b; },
  onToast: toast,
  onAuthExpired: () => { els.reauth.hidden = false; },
  onSetupNeeded: () => enterSetup(),
  hasUnsentEdits: () => sendTimer !== null,
});

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
    editable: () => engine.canEdit,
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
  sendTimer = setTimeout(sendUpdate, 250);
}

function flushPendingSend() {
  if (sendTimer) { clearTimeout(sendTimer); sendUpdate(); }
}

function sendUpdate() {
  sendTimer = null;
  if (!view) return;
  engine.editorChanged(docToBlocks(view.state.doc));
}

function applyRemote(blocks, marks) {
  if (!view) return;
  const newDoc = blocksToDoc(blocks);
  applyingRemote = true;
  try {
    if (!newDoc.eq(view.state.doc)) {
      // Remember the selection as (block id, offset into block).
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
      view.dispatch(tr.setMeta("addToHistory", false).setMeta(pendingKey, marks));
    } else {
      view.dispatch(view.state.tr.setMeta(pendingKey, marks));
    }
  } finally {
    applyingRemote = false;
  }
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


// --- Languages UI ------------------------------------------------------------------

els.langSelect.onchange = () => {
  flushPendingSend();
  const code = els.langSelect.value;
  localStorage.setItem(`babel-lang-${engine.docId}`, code);
  const url = new URL(location.href);
  url.searchParams.set("lang", code);
  history.replaceState(null, "", url);
  engine.setLanguage(code);
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

function addLanguage() {
  const raw = els.addLangInput.value.trim();
  if (!raw) return;
  els.addLangPanel.hidden = true;
  engine.addLanguage(raw);
}

// --- Setup (no babel:meta tab yet) --------------------------------------------------

function enterSetup() {
  if (!engine.canEdit) {
    showView("landing");
    els.landingStatus.textContent =
      "This document isn't set up for Babbel Docs yet, and you don't have edit access to set it up.";
    return;
  }
  showView("setup");
  els.setupDocName.textContent = engine.docName || "this document";
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
    await verifyApiKey(apiKey);
    els.setupStatus.textContent = "Setting up document tabs…";
    showEditorChrome();
    await engine.setupDocument({ code, name, apiKey });
  } catch (err) {
    console.error(err);
    showView("setup");
    els.setupStatus.textContent = `Setup failed: ${err.message}`;
  } finally {
    els.setupGo.disabled = false;
  }
};

// --- Landing / boot ------------------------------------------------------------------

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

function showEditorChrome() {
  showView("editor");
  els.reauth.hidden = true;
  els.docName.textContent = engine.docName;
  els.openInDocs.href = `https://docs.google.com/document/d/${engine.docId}/edit`;
  els.readonly.hidden = engine.canEdit;
  if (!view) createEditor();
}

async function openDoc(id) {
  els.landingStatus.textContent = "Opening document…";
  try {
    engine.close();
    const params = new URL(location.href).searchParams;
    const preferred = params.get("lang") || localStorage.getItem(`babel-lang-${id}`) || null;
    const { docName } = await engine.open(id, preferred);
    rememberDoc(id, docName);
    const url = new URL(location.href);
    url.searchParams.set("doc", id);
    history.replaceState(null, "", url);
    showEditorChrome();
    await engine.start();
  } catch (err) {
    console.error(err);
    showView("landing");
    els.landingStatus.textContent = `Couldn't open document: ${err.message}`;
  }
}

els.share.onclick = async () => {
  const url = `${location.origin}${location.pathname}?doc=${engine.docId}&lang=${encodeURIComponent(engine.lang)}`;
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

els.reauth.onclick = async () => {
  try {
    await G.signIn();
    els.reauth.hidden = true;
    engine.resumeAfterSignIn();
  } catch (err) {
    toast(`Sign-in failed: ${err.message}`, true);
  }
};

els.openOther.onclick = () => {
  clearTimeout(sendTimer);
  sendTimer = null;
  engine.close();
  const url = new URL(location.href);
  url.searchParams.delete("doc");
  url.searchParams.delete("lang");
  history.replaceState(null, "", url);
  showLanding();
};

// Pull immediately when the window regains focus.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) engine.poke();
});

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
  if (G.isSignedIn()) openFromUrl();
})();

window.babbel = { toMarkdown: () => mdSerializer.serialize(view.state.doc), insertMarkdown };
