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
  mergeBlocks, renderBlocks, blockContext, diffSentenceIndices, sentencePlainOffsets,
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
let queuedWrites = 0;
let lockedBlocks = new Set();      // block ids locked by other clients (being translated)
const clientId = newId();
const translateTimers = new Map(); // blockId -> timeout
const heldBlocks = new Set();      // blocks edited locally, translation held until typing pauses (green)
const heldLocks = new Set();       // blockIds we hold appProperties locks for
const editBase = new Map();        // blockId -> html displayed before the local edit (conflict base)
const mergedBlocks = new Set();    // blocks just merged by Claude (purple highlight)
const warnedLong = new Set();      // blocks already warned about length
let lastActivityAt = 0;            // recent doc activity => poll content faster
const LONG_BLOCK_CHARS = 900;
const prevHtmlById = new Map();    // blockId -> pre-edit source html (in-memory only, for sentence diffing)
const sentenceState = new Map();   // blockId -> {n, d, ins} sentence-level change info (own edits + others' locks)

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
  let any = false;
  if (model) {
    const ids = new Set(model.blocks.map((b) => b.id));
    for (const sid of lockedBlocks) if (ids.has(sid)) { any = true; break; }
    if (!any) any = model.blocks.some((b) => b.pending?.length);
  }
  els.translating.hidden = !any;
}

function decorationInput(rendered) {
  // For every block awaiting/undergoing translation, decide what to highlight
  // in the current view: outgoing (blue) sentences in the source language,
  // incoming (yellow) sentences + insertion gaps in target languages. Without
  // sentence info (no history / unaligned), fall back to the whole block.
  const blockById = new Map(model.blocks.map((b) => [b.id, b]));
  const map = new Map();
  for (const rb of rendered) {
    const blk = blockById.get(rb.id);
    if (mergedBlocks.has(rb.id)) { map.set(rb.id, { kind: "merged", all: true }); continue; }
    const active = lockedBlocks.has(rb.id) || !!rb.pending || !!blk?.pending?.length;
    if (!active || !blk) continue;
    const st = sentenceState.get(rb.id);
    const offsets = () => sentencePlainOffsets(rb.html);
    if (lang === blk.source) {
      const kind = heldBlocks.has(rb.id) ? "editing" : "out"; // green while you write, blue while it translates
      if (st?.n?.length) {
        const off = offsets();
        map.set(rb.id, { kind, sents: st.n.filter((i) => i < off.length).map((i) => off[i]) });
      } else {
        map.set(rb.id, { kind, all: true });
      }
    } else if ((blk.pending || []).includes(lang) || lockedBlocks.has(rb.id)) {
      if (st && (st.d?.length || st.ins?.length)) {
        const off = offsets();
        map.set(rb.id, {
          kind: "in",
          sents: (st.d || []).filter((i) => i < off.length).map((i) => off[i]),
          ins: (st.ins || []).map((i) => (i < off.length ? off[i][0] : (off[off.length - 1]?.[1] ?? 0))),
        });
      } else {
        map.set(rb.id, { kind: "in", all: true });
      }
    }
  }
  return map;
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
  sendTimer = setTimeout(sendUpdate, 250);
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
    if (prev && !editBase.has(b.id)) editBase.set(b.id, prev.html); // conflict base: what we edited FROM
    lastReceived.set(b.id, { html: b.html, sig });
    return b;
  });
  const removed = lastReceived.size !== blocks.length;
  if (!(changed || removed || skippedRemote)) return;
  skippedRemote = false;
  const ids = new Set(blocks.map((b) => b.id));
  for (const id of [...lastReceived.keys()]) {
    if (!ids.has(id)) {
      lastReceived.delete(id);
      // A dirty block that got deleted must not pin its lock (and everyone's
      // "Translating…" badge) until the TTL.
      clearTimeout(translateTimers.get(id));
      translateTimers.delete(id);
      heldBlocks.delete(id);
      editBase.delete(id);
      if (heldLocks.has(id)) releaseLock(id);
    }
  }

  const beforeOrder = model.blocks.map((b) => b.id).join(",");
  const beforeSigs = new Map(model.blocks.map((b) => [b.id, sigOf(b)]));
  const oldSourceById = new Map(model.blocks.map((b) => [b.id, b.source]));
  const dirty = mergeBlocks(model, payload, lang);
  // Keep the pre-edit source text in memory for sentence-level diffing; it is
  // not persisted (a dead client just costs one whole-block retranslation).
  for (const id of dirty) {
    const b = model.blocks.find((x) => x.id === id);
    if (b?.prev_html && !prevHtmlById.has(id)) prevHtmlById.set(id, b.prev_html);
    const info = diffSentenceIndices(prevHtmlById.get(id), b?.content[b.source]);
    if (info) sentenceState.set(id, info);
    else sentenceState.delete(id); // no history: whole-block highlight
  }
  // Type/attr changes (heading toggle, list indent) and reorders show in every
  // language tab, so they force a full rewrite of all of them; plain text
  // edits only rewrite the changed blocks in our own tab. Staleness reaches
  // the other tabs through the source tab's new ownHash — no meta write, no
  // other-tab writes needed for a plain edit.
  const structureChanged =
    model.blocks.map((b) => b.id).join(",") !== beforeOrder ||
    model.blocks.some((b) => beforeSigs.has(b.id) && beforeSigs.get(b.id) !== sigOf(b));
  const plans = {};
  if (structureChanged) {
    for (const l of model.languages) plans[l.code] = "full";
  } else {
    plans[lang] = new Set(dirty);
    // When a block's source language changes (edited in a language that
    // wasn't the source), revoke the old source tab's own==src claim in the
    // SAME atomic write — otherwise other clients briefly see two tabs
    // claiming source and can mark the fresh edit as stale.
    for (const id of dirty) {
      const old = oldSourceById.get(id);
      if (old && old !== lang) (plans[old] = plans[old] || new Set()).add(id);
    }
  }
  // Take the locks NOW (not when translation starts 1s later) so other
  // clients get the sentence-level info before the content pull marks the
  // block pending — otherwise they flash a whole-paragraph highlight first.
  if (dirty.length && canEdit) {
    const lockProps = {};
    for (const id of dirty) {
      lockProps[lockKey(id)] = `${clientId}:${Date.now()}${encodeLockSpec(sentenceState.get(id))}`;
      heldLocks.add(id);
    }
    G.setAppProperties(docId, lockProps).catch(() => {});
  }
  // Hold + arm the translation BEFORE painting, so the changed sentences show
  // green (held) from the very first edit; the translation fires ~1s after
  // typing pauses (each send resets the fuse). Warn once on huge paragraphs —
  // whole paragraphs are the unit of sync, merge and translation.
  for (const id of dirty) {
    heldBlocks.add(id);
    scheduleTranslate(id, 800);
    const b = model.blocks.find((x) => x.id === id);
    const len = stripTags(b?.content[lang] || "").length;
    if (len > LONG_BLOCK_CHARS && !warnedLong.has(id)) {
      warnedLong.add(id);
      toast("This paragraph is getting long — Babbel syncs, merges and translates whole paragraphs, so consider splitting it.", true);
    } else if (len < LONG_BLOCK_CHARS / 2) {
      warnedLong.delete(id);
    }
  }
  applyLocalModel();
  queueWrite(plans, false);
}

function applyLocalModel() {
  // Refresh pending highlights + cost from the local model without touching text.
  if (!view) return;
  const rendered = renderBlocks(model, lang);
  view.dispatch(view.state.tr.setMeta(pendingKey, decorationInput(rendered)));
  updateTranslating();
  updateCost();
}

function applyRemote(blocks) {
  if (!view) return;
  if (hasUnsentChanges()) { skippedRemote = true; return; }

  lastReceived = new Map(blocks.map((b) => [b.id, { html: b.html, sig: sigOf(b) }]));
  const pending = decorationInput(blocks);
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

// The meta tab stores config + cost only; all text and per-block sync state
// live in the language tabs and their named ranges.
const metaConfig = () => ({
  babel: 2,
  model: model.model,
  apiKey: model.apiKey,
  languages: model.languages,
  usage: model.usage,
});

function rangeNameFor(block, code) {
  // babel:<id>:<ownHash>:<srcHash> for what we are about to write into `code`.
  const html = block.content[code] ?? block.content[block.source] ?? Object.values(block.content)[0] ?? "";
  const own = D.blockHash(block.type, block.attrs, html);
  let src;
  if (code === block.source) src = own;
  else if (block.pending?.includes(code)) src = D.STALE_HASH;
  else src = D.blockHash(block.type, block.attrs, block.content[block.source] ?? "");
  return D.rangeName(block.id, own, src);
}

function buildWriteRequests(tabPlans, metaChanged) {
  // tabPlans: {langCode: "full" | Set(blockIds)} — always built against the
  // current docSnapshot, so indices match the revision we condition on.
  const requests = [];
  const blockById = new Map(model.blocks.map((b) => [b.id, b]));
  for (const [code, plan] of Object.entries(tabPlans || {})) {
    const tab = langTab(code);
    if (!tab) continue;
    const rendered = renderBlocks(model, code);
    const nameFor = (rb) => rangeNameFor(blockById.get(rb.id), code);
    if (plan === "full") {
      requests.push(...D.fullTabRewriteRequests(tab, rendered, nameFor));
    } else {
      const parsed = D.parseLanguageTab(tab);
      const spans = parsed.spans;
      const oldNameById = new Map(parsed.blocks.filter((b) => b.id).map((b) => [b.id, b.name]));
      const targets = rendered
        .filter((b) => plan.has(b.id) && spans.has(b.id))
        .sort((a, b) => spans.get(b.id)[0] - spans.get(a.id)[0]); // bottom-up
      const missing = [...plan].some((id) => !spans.get(id) && rendered.some((b) => b.id === id));
      if (missing) {
        requests.push(...D.fullTabRewriteRequests(tab, rendered, nameFor));
      } else {
        for (const b of targets) {
          requests.push(...D.singleBlockRewriteRequests(
            tab, b, spans.get(b.id), nameFor(b), [oldNameById.get(b.id)].filter(Boolean)));
        }
      }
    }
  }
  if (metaChanged) {
    const metaTab = D.findMetaTab(docSnapshot);
    if (metaTab) requests.push(...D.metaRewriteRequests(metaTab, metaConfig()));
  }
  return requests;
}

async function resolveConflicts(tabPlans) {
  // Two people edited the same paragraph at the same time (in the same
  // language): the tab already holds THEIR version while we are about to
  // write OURS. Instead of last-write-wins, have Claude merge the two
  // versions against the base we both started from. Merged paragraphs get a
  // purple highlight and are retranslated.
  if (!model?.apiKey) return;
  for (const [code, plan] of Object.entries(tabPlans || {})) {
    if (plan === "full" || !plan?.size) continue;
    const tab = langTab(code);
    if (!tab) continue;
    const parsed = D.parseLanguageTab(tab);
    const tabHtml = new Map(parsed.blocks.filter((b) => b.id).map((b) => [b.id, b.html]));
    for (const id of plan) {
      const base = editBase.get(id);
      const block = model.blocks.find((b) => b.id === id);
      const theirs = tabHtml.get(id);
      const ours = block?.content[code];
      if (base === undefined || !block || theirs === undefined || ours === undefined) continue;
      if (theirs === base || theirs === ours || !stripTags(theirs).trim()) continue;
      // Genuine concurrent edit. Merge with Claude (Sonnet).
      mergedBlocks.add(id);
      applyLocalModel();
      const spent = { input: 0, output: 0, calls: 0 };
      const cfg = { apiKey: model.apiKey, model: model.model || T.DEFAULT_MODEL };
      try {
        const merged = await T.mergeParagraphs(cfg, base, ours, theirs, langName(code), spent);
        model.usage.input_tokens += spent.input;
        model.usage.output_tokens += spent.output;
        model.usage.calls += spent.calls;
        model.usage.cost_usd += T.costOf(cfg.model, spent.input, spent.output);
        block.content[code] = sanitizeInlineHtml(merged);
        block.source = code;
        block.prev_html = base;
        block.pending = model.languages.map((l) => l.code).filter((c) => c !== code);
        if (lang === code) {
          // Reflect the merge in the editor (applyRemote respects unsent edits).
          lastReceived.delete(id);
          applyRemote(renderBlocks(model, lang));
        }
        scheduleTranslate(id, 400);
        toast("Merged simultaneous edits to a paragraph");
      } catch (err) {
        console.error(err);
        toast(`Couldn't merge simultaneous edits: ${err.message}`, true);
      }
      setTimeout(() => { mergedBlocks.delete(id); applyLocalModel(); }, 5000);
    }
  }
}

function queueWrite(tabPlans, metaChanged) {
  // Writes are serialized, conditioned on the snapshot's revisionId, and
  // rebuilt from a fresh snapshot when another client wrote in between.
  queuedWrites += 1;
  writeChain = writeChain.then(async () => {
    if (!model) return;
    writing = true;
    setSync("busy", "Saving…");
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await resolveConflicts(tabPlans);
          const requests = buildWriteRequests(tabPlans, metaChanged);
          if (requests.length) {
            await G.batchUpdate(docId, requests, docSnapshot.revisionId);
            await refreshSnapshot();
          }
          break;
        } catch (err) {
          if (err.authExpired || attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          await refreshSnapshot(); // doc moved under us — rebuild and retry
        }
      }
      // Our edits are canonical now; future edits get a fresh conflict base.
      for (const [, plan] of Object.entries(tabPlans || {})) {
        if (plan instanceof Set) for (const id of plan) editBase.delete(id);
        else if (plan === "full") editBase.clear();
      }
      setSync("on", "Synced");
    } catch (err) {
      console.error(err);
      if (err.authExpired) {
        setSync("off", "Signed out");
        els.reauth.hidden = false;
        toast("Google sign-in expired — click Sign in to resume syncing", true);
      } else {
        setSync("off", "Save failed");
        toast(`Save failed: ${err.message}`, true);
      }
      // Re-pull on next poll so we converge with whatever is in the doc.
      lastVersion = null;
      lastRevision = null;
    } finally {
      writing = false;
      queuedWrites -= 1;
    }
  });
  return writeChain;
}

function deriveModel(doc, meta) {
  // Rebuild the block model purely from the language tabs + range names.
  // Text lives only in the tabs; ownHash/srcHash in the range names tell us
  // consistency (edited outside the app?) and staleness (needs translating?).
  const perLang = [];
  for (const l of meta.languages) {
    const tab = D.tabById(doc, l.tabId);
    if (tab) perLang.push({ code: l.code, ...D.parseLanguageTab(tab) });
  }
  if (!perLang.length) return { blocks: [], repairs: false };

  const dirtyOf = (pl) => pl.blocks.some((b) => !b.id || b.own !== b.hash);
  // An externally edited tab has the newest text: it defines the order and,
  // per block, becomes the new source language.
  const base = perLang.find(dirtyOf) || perLang[0];
  for (const b of base.blocks) if (!b.id) b.id = newId();

  const byLang = new Map(perLang.map((pl) =>
    [pl.code, new Map(pl.blocks.filter((b) => b.id).map((b) => [b.id, b]))]));

  const blocks = [];
  for (const bb of base.blocks) {
    const entries = new Map();
    for (const pl of perLang) {
      const e = pl === base ? bb : byLang.get(pl.code).get(bb.id);
      if (e) entries.set(pl.code, e);
    }
    let source = null;
    for (const [code, e] of entries) if (!e.own || e.own !== e.hash) { source = code; break; } // edited wins
    if (!source) {
      // Among tabs claiming source (own==src), prefer the one the other
      // tabs' srcHashes actually point at — resolves transient dual claims.
      let bestScore = -1;
      for (const [code, e] of entries) {
        if (!e.own || e.own !== e.src) continue;
        let score = 0;
        for (const [c2, e2] of entries) if (c2 !== code && e2.src === e.hash) score++;
        if (score > bestScore) { bestScore = score; source = code; }
      }
    }
    if (!source) source = base.code;
    const srcEntry = entries.get(source) || bb;
    const shared = srcEntry.type === "code" || !stripTags(srcEntry.html).trim();
    const content = {}, pending = [];
    for (const l of meta.languages) {
      const e = entries.get(l.code);
      if (e) content[l.code] = e.html;
      if (l.code === source || shared) continue;
      if (!e || e.src !== srcEntry.hash) pending.push(l.code);
    }
    blocks.push({ id: bb.id, type: srcEntry.type, attrs: srcEntry.attrs, content, source, pending });
  }

  const baseOrder = base.blocks.map((b) => b.id).join(",");
  const structural = perLang.some((pl) =>
    pl !== base && pl.blocks.map((b) => b.id).filter(Boolean).join(",") !== baseOrder);
  return { blocks, repairs: perLang.some(dirtyOf) || structural };
}

async function pullDoc() {
  const doc = await G.getDocument(docId);
  docSnapshot = doc;
  lastRevision = doc.revisionId;
  const metaTab = D.findMetaTab(doc);
  const meta = metaTab ? D.parseMeta(metaTab) : null;
  if (!meta || meta.babel !== 2) { enterSetup(doc); return; }

  const { blocks, repairs } = deriveModel(doc, meta);
  model = { ...meta, blocks };
  model.usage = model.usage || { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 };

  if (!model.languages.some((l) => l.code === lang)) {
    lang = model.languages[0]?.code;
  }

  // Repair pass (external edits / structural drift): rewrite all tabs so
  // every range name matches reality again — but never while our own writes
  // or edits are still in flight, which would clobber them.
  // Defer repairs while another client is mid-flight (its locks are live) —
  // competing full rewrites are what turn into revision-conflict storms.
  if (repairs && canEdit && !queuedWrites && !hasUnsentChanges() && !lockedBlocks.size) {
    const plans = {};
    for (const l of model.languages) plans[l.code] = "full";
    queueWrite(plans, false);
  }
  // Pick up stale blocks (external edit, dead translator, new language) —
  // slowly, and never ones another client is already translating: the
  // editing client schedules its own work at ~1s and should win.
  if (canEdit && model.apiKey && !queuedWrites) {
    for (const b of model.blocks) {
      if (b.pending?.length && !lockedBlocks.has(b.id) && !heldLocks.has(b.id)) {
        scheduleTranslate(b.id, 4000);
      }
    }
  }

  applyRemote(renderBlocks(model, lang));
  updateLangSelect();
  updateCost();
  updateTranslating();
}

async function pollLoop() {
  clearTimeout(pollTimer);
  try {
    if (!writing && !queuedWrites && model) {
      const meta = await G.getFileMeta(docId);
      scanLocks(meta.appProperties); // lock highlights ride the 500ms poll
      // Drive version bumps on any change (incl. lock patches); revisionId
      // only on content changes — pull the doc just for the latter. While
      // there's recent activity (locks live, edits in flight) probe the
      // revision every tick so translations land fast; idle docs probe 4x
      // slower to stay inside the Docs read quota.
      const active = lockedBlocks.size || heldLocks.size ||
        Date.now() - lastActivityAt < 15000;
      if (meta.version !== lastVersion) {
        lastActivityAt = Date.now();
        docName = meta.name;
        els.docName.textContent = docName;
        if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
        lastVersion = meta.version; // commit only after a successful pull
      } else if (active || pollTick % 4 === 3) {
        // Backstop: Drive's version field can lag content changes.
        if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
      }
      setSync("on", "Synced");
    }
  } catch (err) {
    console.error(err);
    if (err.authExpired) {
      // Never open Google's popup automatically — pause sync and wait for
      // the user to click the Sign in button.
      setSync("off", "Signed out");
      els.reauth.hidden = false;
      return;
    }
    setSync("off", "Reconnecting…");
  }
  pollTick += 1;
  pollTimer = setTimeout(pollLoop, 500);
}

els.reauth.onclick = async () => {
  try {
    await G.signIn();
    els.reauth.hidden = true;
    lastVersion = null; // force a pull to catch up on whatever we missed
    lastRevision = null;
    pollLoop();
  } catch (err) {
    toast(`Sign-in failed: ${err.message}`, true);
  }
};

// Pull immediately when the window regains focus, so switching between two
// windows feels instant.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && docId && model) pollLoop();
});


// --- Locks (invisible Drive appProperties) ----------------------------------------------

const LOCK_TTL_MS = 2 * 60 * 1000;
const lockKey = (blockId) => `lock_${blockId}`;

function parseLockVal(v) {
  if (!v) return null;
  const [c, t, spec] = String(v).split(":");
  const out = { c, t: Number(t) || 0, st: null };
  // spec: "n1,3;d1;i2" — sentence indices (see diffSentenceIndices).
  const m = spec && spec.match(/^n([\d,]*);d([\d,]*);i([\d,]*)$/);
  if (m) {
    const nums = (s) => s ? s.split(",").map(Number) : [];
    out.st = { n: nums(m[1]), d: nums(m[2]), ins: nums(m[3]) };
  }
  return out;
}

function encodeLockSpec(st) {
  if (!st) return "";
  const spec = `n${st.n.join(",")};d${st.d.join(",")};i${st.ins.join(",")}`;
  return spec.length <= 80 ? `:${spec}` : ""; // appProperties values cap at ~124 bytes
}

async function acquireLock(blockId) {
  // appProperties are per-key, so concurrent clients can't clobber each
  // other's locks; the write-then-read-back settles same-key races. The value
  // carries the affected sentences so other clients highlight only those.
  if (heldLocks.has(blockId)) return true; // already taken at edit time
  const key = lockKey(blockId);
  const pre = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
  if (pre && pre.c !== clientId && Date.now() - pre.t < LOCK_TTL_MS) return false;
  const spec = encodeLockSpec(sentenceState.get(blockId));
  await G.setAppProperties(docId, { [key]: `${clientId}:${Date.now()}${spec}` });
  const post = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
  if (post?.c !== clientId) return false;
  heldLocks.add(blockId);
  return true;
}

async function releaseLock(blockId) {
  heldLocks.delete(blockId);
  await G.setAppProperties(docId, { [lockKey(blockId)]: null }).catch(() => {});
}

function scanLocks(appProperties) {
  // Runs on every poll: refresh the "being translated elsewhere" highlight set
  // and garbage-collect expired locks left by dead clients.
  const fresh = new Set();
  const staleKeys = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(appProperties || {})) {
    if (!k.startsWith("lock_")) continue;
    const l = parseLockVal(v);
    if (l && now - l.t < LOCK_TTL_MS) {
      if (l.c !== clientId) {
        const blockId = k.slice(5);
        fresh.add(blockId);
        // Adopt the locker's sentence info (our own edits take precedence).
        if (l.st && !prevHtmlById.has(blockId)) sentenceState.set(blockId, l.st);
      }
    } else if (canEdit) {
      staleKeys[k] = null;
    }
  }
  if (Object.keys(staleKeys).length) G.setAppProperties(docId, staleKeys).catch(() => {});
  const changed = fresh.size !== lockedBlocks.size || [...fresh].some((b) => !lockedBlocks.has(b));
  lockedBlocks = fresh;
  if (changed) lastActivityAt = Date.now();
  if (changed && model) applyLocalModel();
}

// --- Translation ------------------------------------------------------------------------

function scheduleTranslate(blockId, delay = 1000) {
  if (!canEdit) return;
  if (!model?.apiKey) { toast("No Anthropic API key in babel:meta — translations are paused", true); return; }
  clearTimeout(translateTimers.get(blockId));
  translateTimers.set(blockId, setTimeout(() => {
    translateTimers.delete(blockId);
    heldBlocks.delete(blockId);
    applyLocalModel(); // green (held while writing) -> blue (translating)
    translateBlock(blockId).catch((err) => {
      console.error(err);
      toast(`Translation failed: ${err.message}`, true);
    });
  }, delay));
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
    const prevHtml = prevHtmlById.get(blockId) ?? block.prev_html;

    const results = await Promise.allSettled(targets.map((t) =>
      T.translateBlockTo(cfg, sourceHtml, prevHtml, block.content[t],
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
    if (!cur.pending?.length) {
      delete cur.prev_html;
      prevHtmlById.delete(blockId);
      sentenceState.delete(blockId);
    }
    queueWrite(changedTabs, true); // meta carries the updated usage/cost
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
      const blockById = new Map(model.blocks.map((b) => [b.id, b]));
      const requests = [
        ...D.fullTabRewriteRequests(tab, renderBlocks(model, code),
          (rb) => rangeNameFor(blockById.get(rb.id), code)),
        ...D.metaRewriteRequests(D.findMetaTab(docSnapshot), metaConfig()),
      ];
      await G.batchUpdate(docId, requests, docSnapshot.revisionId);
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
      babel: 2,
      model: T.DEFAULT_MODEL,
      apiKey,
      languages: [{ code, name, tabId: firstTab.tabProperties.tabId }],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 },
      blocks,
    };
    // Reuse an existing babel:meta tab (e.g. re-setup of a v1 document).
    const existingMeta = D.findMetaTab(doc);
    const metaTabId = existingMeta
      ? existingMeta.tabProperties.tabId
      : await G.addTab(docId, D.META_TAB_TITLE);
    const fresh = await G.getDocument(docId);
    const langTabFresh = D.tabById(fresh, firstTab.tabProperties.tabId);
    const metaTabFresh = D.tabById(fresh, metaTabId);
    await G.batchUpdate(docId, [
      { updateDocumentTabProperties: {
        tabProperties: { tabId: firstTab.tabProperties.tabId, title: name }, fields: "title" } },
      ...D.fullTabRewriteRequests(langTabFresh, renderBlocks(model, code),
        (rb) => rangeNameFor(model.blocks.find((b) => b.id === rb.id), code)),
      ...D.metaRewriteRequests(metaTabFresh, metaConfig()),
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
  els.reauth.hidden = true;
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
  lockedBlocks = new Set();
  clearTimeout(sendTimer);
  sendTimer = null;
  for (const t of translateTimers.values()) clearTimeout(t);
  translateTimers.clear();
  heldBlocks.clear();
  editBase.clear();
  mergedBlocks.clear();
  warnedLong.clear();
  sentenceState.clear();
  prevHtmlById.clear();
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
