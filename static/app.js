// Babbel Docs frontend: ProseMirror editor synced to a Google Doc.
//
// The Google Doc is the database (storage v3, two-tier): language tabs are
// the only store of text; paragraphs carry identity/structure in babelp:
// named ranges; SENTENCES are the sync unit, each with a babel:<sid> range
// whose name carries ownHash (consistency) + srcHash (staleness). The meta
// tab holds config/cost only. This client polls Drive metadata (locks ride
// along) and the Docs revisionId, rebuilds the model from the tabs on every
// pull, diffs local edits into per-sentence intents (re-applied on write
// conflicts, which is what makes concurrent same-paragraph edits merge), and
// translates changed sentences with Claude, locked per sentence via
// invisible appProperties.

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
  splitSentencesHtml, computeSentenceMerge, mergeSidSequences,
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

// Translation-state decorations. Input: Map(pid -> {sentsIn, sentsOut, ins}):
// sentsIn (yellow) = spans an incoming translation will replace; sentsOut
// (blue) = spans being translated outward; ins = offsets where newly added,
// not-yet-translated text will appear (blank-space placeholder widgets).
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
          // The text lives in the node itself, except list items, where it
          // lives in the first (paragraph) child.
          let textNode = node, textPos = pos;
          if (node.type.name === "list_item" && node.firstChild) {
            textNode = node.firstChild;
            textPos = pos + 1;
          }
          const base = textPos + 1;
          const max = textNode.content.size;
          const push = (ranges, cls) => {
            for (const [s, e] of ranges || []) {
              const a = Math.min(s, max), b = Math.min(e, max);
              if (b > a) decos.push(Decoration.inline(base + a, base + b, { class: cls }));
            }
          };
          push(m.sentsIn, "pending");
          push(m.sentsOut, "outgoing");
          for (const off of m.ins || []) {
            decos.push(Decoration.widget(base + Math.min(off, max), gapWidget, { side: -1 }));
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
let model = null;              // {languages, apiKey, model, usage, paras, sents(Map)}
let docSnapshot = null;        // last fetched documents.get result
let lastVersion = null;        // Drive file version we've already pulled
let lastRevision = null;       // Docs revisionId we've already pulled
let pollTick = 0;
let lastReceived = new Map();  // pid -> {html, sig, sents:[{sid, html}]} last rendered for our lang
let sendTimer = null;
let applyingRemote = false;
let skippedRemote = false;
let pollTimer = null;
let writeChain = Promise.resolve();
let writing = false;
let queuedWrites = 0;
let lockedSids = new Set();    // sentence ids other clients are translating
let currentIntents = null;     // latest unwritten local edits (re-applied on write conflicts)
const clientId = newId();
const translateTimers = new Map(); // sid -> timeout
const heldLocks = new Set();       // sids we hold appProperties locks for

const sigOf = (b) => `${b.type}|${JSON.stringify(b.attrs || {})}`;
const langName = (code) => model?.languages.find((l) => l.code === code)?.name || code;
const langTab = (code) => {
  const entry = model?.languages.find((l) => l.code === code);
  return entry && docSnapshot ? D.tabById(docSnapshot, entry.tabId) : null;
};
const isShared = (paraType, html) => paraType === "code" || !stripTags(html || "").trim();

function plainLen(html, isCode) {
  // Length of html's text as ProseMirror counts it (<br> = 1 position).
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent.length + (isCode ? 0 : div.querySelectorAll("br").length);
}

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
  let any = lockedSids.size > 0;
  if (!any && model) {
    for (const s of model.sents.values()) if (s.pending?.length) { any = true; break; }
  }
  els.translating.hidden = !any;
}

function decorationInput(blocks) {
  // Per paragraph: sentence spans to highlight in the current view. Yellow
  // (in) = an incoming translation will replace this; blue (out) = this is
  // being translated outward; ins = placeholders for untranslated inserts.
  const map = new Map();
  for (const b of blocks) {
    const sentsIn = [], sentsOut = [], ins = [];
    for (const pc of b.pieces || []) {
      if (pc.gap) { ins.push(pc.at); continue; }
      const s = model.sents.get(pc.sid);
      const locked = lockedSids.has(pc.sid);
      const out = pc.outgoing || (locked && s?.source === lang);
      const inc = pc.pending || (locked && s?.source !== lang);
      if (out) sentsOut.push([pc.start, pc.end]);
      else if (inc) sentsIn.push([pc.start, pc.end]);
    }
    if (sentsIn.length || sentsOut.length || ins.length) map.set(b.id, { sentsIn, sentsOut, ins });
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
  let changed = blocks.length !== lastReceived.size;
  for (const b of blocks) {
    const prev = lastReceived.get(b.id);
    if (!prev || prev.html !== b.html || prev.sig !== sigOf(b)) { changed = true; break; }
  }
  if (!(changed || skippedRemote)) return;
  skippedRemote = false;

  // Flat sentence diff (old displayed vs editor) assigns sentence ids: equal
  // sentences keep their id (even across paragraph splits/merges), edited
  // ones reuse the id they replace, added ones get fresh ids.
  const oldFlat = [];
  for (const rec of lastReceived.values()) {
    for (const s of rec.sents || []) oldFlat.push({ sid: s.sid, html: s.html });
  }
  const newFlat = [];
  for (const b of blocks) {
    const clean = b.type === "code" ? b.html : sanitizeInlineHtml(b.html);
    const parts = b.type === "code" ? [clean] : splitSentencesHtml(clean);
    for (const part of parts) newFlat.push({ pid: b.id, html: part });
  }
  const merge = computeSentenceMerge(oldFlat, newFlat);

  const newParas = blocks.map((b) => ({ pid: b.id, type: b.type, attrs: b.attrs, sents: [] }));
  const byPid = new Map(newParas.map((p) => [p.pid, p]));
  for (const s of merge.sents) byPid.get(s.pid).sents.push(s);

  // Structural change: paragraph list changed, or a kept sentence moved to a
  // different paragraph (split/merge) — all tabs must be rewritten.
  const oldStruct = model.paras.map((p) => `${p.pid}|${sigOf(p)}`).join(",");
  const newStruct = blocks.map((b) => `${b.id}|${sigOf(b)}`).join(",");
  let structural = oldStruct !== newStruct;
  if (!structural) {
    const oldPidOfSid = new Map();
    for (const p of model.paras) for (const sid of p.sids) oldPidOfSid.set(sid, p.pid);
    for (const s of merge.sents) {
      if (s.sid && !s.changed && oldPidOfSid.has(s.sid) && oldPidOfSid.get(s.sid) !== s.pid) {
        structural = true; break;
      }
    }
  }

  const intents = { lang, structural, newParas, removed: merge.removed };
  currentIntents = intents;
  const { dirtySids, plan } = applyIntents(model, intents);

  for (const b of blocks) {
    lastReceived.set(b.id, {
      html: b.html, sig: sigOf(b),
      sents: byPid.get(b.id).sents.map((s) => ({ sid: s.sid, html: s.html })),
    });
  }
  const ids = new Set(blocks.map((b) => b.id));
  for (const id of [...lastReceived.keys()]) if (!ids.has(id)) lastReceived.delete(id);

  // Take sentence locks NOW so other clients highlight the right sentences
  // before the content pull marks them pending.
  if (dirtySids.length) {
    const lockProps = {};
    for (const sid of dirtySids) {
      lockProps[lockKey(sid)] = `${clientId}:${Date.now()}`;
      heldLocks.add(sid);
    }
    G.setAppProperties(docId, lockProps).catch(() => {});
  }
  applyLocalModel();
  queueWrite(plan, false, intents);
  for (const sid of dirtySids) scheduleTranslate(sid);
}

function applyIntents(m, intents) {
  // Fold local edit intents into a model (fresh from a pull, or re-derived
  // after a write conflict). Returns the dirty sids and the write plan.
  const editLang = intents.lang;
  const others = m.languages.map((l) => l.code).filter((c) => c !== editLang);
  for (const sid of intents.removed) m.sents.delete(sid);
  m.paras = intents.newParas.map((p) => ({
    pid: p.pid, type: p.type, attrs: p.attrs, sids: p.sents.map((s) => s.sid),
  }));
  const dirtySids = [];
  const touched = new Set();
  for (const p of intents.newParas) {
    for (const s of p.sents) {
      if (!s.changed && !s.sepOnly) continue;
      touched.add(p.pid);
      let sent = m.sents.get(s.sid);
      if (!sent) {
        sent = { source: editLang, content: {}, pending: [] };
        m.sents.set(s.sid, sent);
      }
      sent.content[editLang] = s.html;
      if (!s.changed) continue; // trailing-whitespace only: write, don't retranslate
      sent.source = editLang;
      if (isShared(p.type, s.html)) {
        for (const o of others) sent.content[o] = s.html;
        sent.pending = [];
      } else {
        sent.pending = [...others];
        dirtySids.push(s.sid);
      }
    }
  }
  const plan = intents.structural ? { full: true } : { paras: { [editLang]: touched } };
  return { dirtySids, plan };
}

function applyLocalModel() {
  // Refresh highlights + cost from the local model without touching text.
  if (!view || !model) return;
  view.dispatch(view.state.tr.setMeta(pendingKey, decorationInput(renderView(model, lang))));
  updateTranslating();
  updateCost();
}

function applyRemote(blocks) {
  if (!view) return;
  if (hasUnsentChanges()) { skippedRemote = true; return; }

  lastReceived = new Map(blocks.map((b) => [b.id, {
    html: b.html, sig: sigOf(b),
    sents: (b.pieces || []).filter((p) => !p.gap).map((p) => ({ sid: p.sid, html: p.html })),
  }]));
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

// The meta tab stores config + cost only; all text and per-sentence sync
// state live in the language tabs and their named ranges.
const metaConfig = () => ({
  babel: 3,
  model: model.model,
  apiKey: model.apiKey,
  languages: model.languages,
  usage: model.usage,
});

// --- Model -> view / tab rendering -----------------------------------------------

function renderView(m, code) {
  // Editor blocks for one language, with per-sentence pieces for decorations.
  const blocks = [];
  for (const p of m.paras) {
    const isCode = p.type === "code";
    const pieces = [];
    let html = "";
    let off = 0;
    for (const sid of p.sids) {
      const s = m.sents.get(sid);
      if (!s) continue;
      const c = s.content[code];
      if (c === undefined) {
        // Not translated yet and never populated: show a blank-space gap.
        pieces.push({ sid, gap: true, at: off });
        continue;
      }
      const len = plainLen(c, isCode);
      pieces.push({
        sid, html: c, start: off, end: off + len,
        pending: (s.pending || []).includes(code),
        outgoing: s.source === code && (s.pending || []).length > 0,
      });
      html += c;
      off += len;
    }
    blocks.push({ id: p.pid, type: p.type, attrs: p.attrs, html, pieces });
  }
  return blocks;
}

function renderTabPara(code, p) {
  // What one paragraph should contain in one language tab, with range names.
  const isCode = p.type === "code";
  const pieces = [];
  for (const sid of p.sids) {
    const s = model.sents.get(sid);
    if (!s) continue;
    const c = s.content[code];
    if (c === undefined) continue; // untranslated insert: absent from this tab
    const own = isCode ? D.codeHash(c) : D.sentHash(c);
    let src;
    if (s.source === code) src = own;
    else if ((s.pending || []).includes(code)) src = D.STALE_HASH;
    else {
      const sh = s.content[s.source] ?? "";
      src = isCode ? D.codeHash(sh) : D.sentHash(sh);
    }
    pieces.push({ sid, html: c, own, src });
  }
  return { pid: p.pid, type: p.type, attrs: p.attrs, pieces };
}

const renderTabParas = (code) => model.paras.map((p) => renderTabPara(code, p));

// --- Writes -----------------------------------------------------------------------

function buildWriteRequests(plan, metaChanged) {
  const requests = [];
  if (plan?.full) {
    for (const l of model.languages) {
      const tab = langTab(l.code);
      if (tab) requests.push(...D.fullTabRewriteRequests(tab, renderTabParas(l.code)));
    }
  } else if (plan?.paras) {
    for (const [code, pids] of Object.entries(plan.paras)) {
      const tab = langTab(code);
      if (!tab || !pids.size) continue;
      const parsed = D.parseLanguageTab(tab);
      const byPid = new Map(parsed.paras.filter((p) => p.pid).map((p) => [p.pid, p]));
      const wanted = [...pids].filter((pid) => model.paras.some((p) => p.pid === pid));
      if (wanted.some((pid) => !byPid.has(pid))) {
        requests.push(...D.fullTabRewriteRequests(tab, renderTabParas(code)));
      } else {
        wanted.sort((a, b) => byPid.get(b).span[0] - byPid.get(a).span[0]); // bottom-up
        for (const pid of wanted) {
          const p = model.paras.find((x) => x.pid === pid);
          requests.push(...D.paraRewriteRequests(tab, byPid.get(pid), renderTabPara(code, p)));
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

function queueWrite(plan, metaChanged, intents) {
  // Serialized writes conditioned on the snapshot's revisionId. On conflict
  // (another client wrote first) the model is RE-DERIVED from the fresh doc
  // and our unwritten local edits are re-applied on top — this is what makes
  // two people editing different sentences of the same paragraph merge
  // instead of clobbering each other.
  queuedWrites += 1;
  writeChain = writeChain.then(async () => {
    if (!model) { return; }
    writing = true;
    setSync("busy", "Saving…");
    try {
      let curPlan = plan;
      for (let attempt = 0; ; attempt++) {
        try {
          const requests = buildWriteRequests(curPlan, metaChanged);
          if (requests.length) {
            await G.batchUpdate(docId, requests, docSnapshot.revisionId);
            await refreshSnapshot();
          }
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          await refreshSnapshot();
          const metaTab = D.findMetaTab(docSnapshot);
          const cfg = metaTab ? D.parseMeta(metaTab) : null;
          if (cfg && cfg.babel === 3) {
            model = buildModel(docSnapshot, cfg).model;
            if (intents && currentIntents === intents) {
              curPlan = applyIntents(model, intents).plan;
            }
          }
        }
      }
      if (intents && currentIntents === intents) currentIntents = null;
      setSync("on", "Synced");
    } catch (err) {
      console.error(err);
      setSync("off", "Save failed");
      toast(`Save failed: ${err.message}`, true);
      lastVersion = null;
      lastRevision = null;
    } finally {
      writing = false;
      queuedWrites -= 1;
    }
  });
  return writeChain;
}

// --- Model derivation from the doc ---------------------------------------------------

function buildModel(doc, cfg) {
  // Rebuild the two-tier model purely from the language tabs + range names.
  const perLang = [];
  for (const l of cfg.languages) {
    const tab = D.tabById(doc, l.tabId);
    if (tab) perLang.push({ code: l.code, ...D.parseLanguageTab(tab) });
  }
  const m = { ...cfg, paras: [], sents: new Map() };
  m.usage = m.usage || { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 };
  if (!perLang.length) return { model: m, repairs: false };
  const base = perLang.find((pl) => pl.dirty) || perLang[0];

  // Reconcile externally edited paragraphs: re-split the text heuristically
  // (this IS the edited language) and re-match sentence ids by diff — kept
  // sentences keep ids and translations, edited ones reuse the replaced id.
  for (const pl of perLang) {
    if (!pl.dirty) continue;
    for (const para of pl.paras) {
      if (!para.broken) continue;
      if (!para.pid) para.pid = newId();
      const isCode = para.type === "code";
      const parts = isCode ? [para.rawHtml] : splitSentencesHtml(para.rawHtml);
      const olds = para.sents.map((s) => ({
        sid: s.sid,
        html: s.own === s.hash ? s.html : `\u0000${s.sid}`, // damaged: never matches
      }));
      para.reconciled = computeSentenceMerge(olds, parts.map((h) => ({ pid: para.pid, html: h }))).sents;
    }
  }

  // Collect per-paragraph entries across languages.
  const paraDefs = new Map();
  for (const pl of perLang) {
    for (const para of pl.paras) {
      if (!para.pid) continue;
      let def = paraDefs.get(para.pid);
      if (!def) {
        def = { pid: para.pid, type: para.type, attrs: para.attrs, seqs: [], entries: new Map() };
        paraDefs.set(para.pid, def);
      }
      if (pl === base) { def.type = para.type; def.attrs = para.attrs; }
      const list = para.reconciled
        ? para.reconciled.map((s) => ({ sid: s.sid, html: s.html, edited: s.changed }))
        : para.sents.map((s) => ({ sid: s.sid, html: s.html, own: s.own, src: s.src, hash: s.hash }));
      def.seqs.push({ isBase: pl === base, seq: list.map((s) => s.sid) });
      for (const s of list) {
        if (!def.entries.has(s.sid)) def.entries.set(s.sid, new Map());
        def.entries.get(s.sid).set(pl.code, s);
      }
    }
  }

  for (const bp of base.paras) {
    if (!bp.pid || m.paras.some((p) => p.pid === bp.pid)) continue;
    const def = paraDefs.get(bp.pid);
    if (!def) continue;
    const seqs = [...def.seqs].sort((a, b) => (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0)).map((x) => x.seq);
    const sids = mergeSidSequences(seqs);
    const isCode = def.type === "code";
    for (const sid of sids) {
      if (m.sents.has(sid)) continue;
      const entries = def.entries.get(sid) || new Map();
      let source = null;
      for (const [code, e] of entries) if (e.edited) { source = code; break; }
      if (!source) {
        // Among tabs claiming source (own==src), prefer the one the other
        // tabs' srcHashes actually point at (resolves transient dual claims).
        let bestScore = -1;
        for (const [code, e] of entries) {
          if (!e.own || e.own !== e.src) continue;
          let score = 0;
          for (const [c2, e2] of entries) if (c2 !== code && e2.src === e.hash) score++;
          if (score > bestScore) { bestScore = score; source = code; }
        }
      }
      if (!source) source = entries.keys().next().value;
      if (!source) continue;
      const srcE = entries.get(source);
      const shared = isCode || !stripTags(srcE.html || "").trim();
      const srcHash = srcE.hash ?? (isCode ? D.codeHash(srcE.html) : D.sentHash(srcE.html));
      const content = {};
      const pending = [];
      for (const l of cfg.languages) {
        const e = entries.get(l.code);
        if (e) content[l.code] = e.html;
        if (l.code === source) continue;
        if (shared) { if (!e) content[l.code] = srcE.html; continue; }
        if (!e || e.edited || srcE.edited || e.src !== srcHash) pending.push(l.code);
      }
      m.sents.set(sid, { source, content, pending });
    }
    m.paras.push({ pid: bp.pid, type: def.type, attrs: def.attrs, sids });
  }
  return { model: m, repairs: perLang.some((pl) => pl.dirty) };
}

async function pullDoc() {
  const doc = await G.getDocument(docId);
  docSnapshot = doc;
  lastRevision = doc.revisionId;
  const metaTab = D.findMetaTab(doc);
  const cfg = metaTab ? D.parseMeta(metaTab) : null;
  if (!cfg || cfg.babel !== 3) { enterSetup(doc); return; }

  const built = buildModel(doc, cfg);
  model = built.model;
  const repairs = built.repairs;
  // Keep unwritten local edits on top of the fresh state.
  if (currentIntents) applyIntents(model, currentIntents);

  if (!model.languages.some((l) => l.code === lang)) {
    lang = model.languages[0]?.code;
  }
  if (repairs && canEdit && !queuedWrites && !hasUnsentChanges()) {
    queueWrite({ full: true }, false);
  }
  // Anything stale (external edit, dead translator, new language): translate.
  if (canEdit && model.apiKey && !queuedWrites) {
    for (const [sid, s] of model.sents) if (s.pending?.length) scheduleTranslate(sid);
  }

  applyRemote(renderView(model, lang));
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
      // only on content changes — pull the doc just for the latter.
      if (meta.version !== lastVersion) {
        docName = meta.name;
        els.docName.textContent = docName;
        if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
        lastVersion = meta.version; // commit only after a successful pull
      } else if (pollTick % 2 === 1) {
        // Backstop: Drive's version field can lag content changes.
        if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
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

// --- Locks (invisible Drive appProperties, one per sentence) ----------------------------

const LOCK_TTL_MS = 2 * 60 * 1000;
const lockKey = (sid) => `lock_${sid}`;

function parseLockVal(v) {
  if (!v) return null;
  const [c, t] = String(v).split(":");
  return { c, t: Number(t) || 0 };
}

async function acquireLock(sid) {
  // appProperties are per-key, so concurrent clients can't clobber each
  // other's locks; the write-then-read-back settles same-key races.
  if (heldLocks.has(sid)) return true; // taken at edit time
  const key = lockKey(sid);
  const pre = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
  if (pre && pre.c !== clientId && Date.now() - pre.t < LOCK_TTL_MS) return false;
  await G.setAppProperties(docId, { [key]: `${clientId}:${Date.now()}` });
  const post = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
  if (post?.c !== clientId) return false;
  heldLocks.add(sid);
  return true;
}

async function releaseLock(sid) {
  heldLocks.delete(sid);
  await G.setAppProperties(docId, { [lockKey(sid)]: null }).catch(() => {});
}

function scanLocks(appProperties) {
  // Runs on every poll: refresh the "being translated elsewhere" highlights
  // and garbage-collect expired locks left by dead clients.
  const fresh = new Set();
  const staleKeys = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(appProperties || {})) {
    if (!k.startsWith("lock_")) continue;
    const l = parseLockVal(v);
    if (l && now - l.t < LOCK_TTL_MS) {
      if (l.c !== clientId) fresh.add(k.slice(5));
    } else if (canEdit) {
      staleKeys[k] = null;
    }
  }
  if (Object.keys(staleKeys).length) G.setAppProperties(docId, staleKeys).catch(() => {});
  const changed = fresh.size !== lockedSids.size || [...fresh].some((b) => !lockedSids.has(b));
  lockedSids = fresh;
  if (changed && model) applyLocalModel();
}

// --- Translation (per sentence) --------------------------------------------------------

function scheduleTranslate(sid) {
  if (!canEdit) return;
  if (!model?.apiKey) { toast("No Anthropic API key in babel:meta — translations are paused", true); return; }
  clearTimeout(translateTimers.get(sid));
  translateTimers.set(sid, setTimeout(() => {
    translateTimers.delete(sid);
    translateSid(sid).catch((err) => {
      console.error(err);
      toast(`Translation failed: ${err.message}`, true);
    });
  }, 1000));
}

function paraContext(pid, srcLang) {
  const idx = model.paras.findIndex((p) => p.pid === pid);
  const text = (p) => stripTags(p.sids.map((sid) => model.sents.get(sid)?.content[srcLang] || "").join(""));
  const before = model.paras.slice(Math.max(0, idx - 2), idx).map(text).filter(Boolean).join(" ");
  const after = model.paras.slice(idx + 1, idx + 3).map(text).filter(Boolean).join(" ");
  return { before, after, para: text(model.paras[idx]) };
}

async function translateSid(sid) {
  const s = model?.sents.get(sid);
  if (!s || !s.pending?.length) return;
  if (!(await acquireLock(sid))) return; // another client is on it
  try {
    const source = s.source;
    const srcHtml = s.content[source];
    const para = model.paras.find((p) => p.sids.includes(sid));
    if (!para || srcHtml === undefined) return;
    const targets = [...s.pending];
    const ctx = paraContext(para.pid, source);
    const spent = { input: 0, output: 0, calls: 0 };
    const cfg = { apiKey: model.apiKey, model: model.model || T.DEFAULT_MODEL };
    const tgtPara = (t) => stripTags(para.sids.map((x) => model.sents.get(x)?.content[t] || "").join(""));

    const results = await Promise.allSettled(targets.map((t) =>
      T.translateSentenceTo(cfg, srcHtml, ctx.para, tgtPara(t),
        langName(source), langName(t), ctx, spent)));

    // Record cost even if the result ends up discarded below.
    model.usage.input_tokens += spent.input;
    model.usage.output_tokens += spent.output;
    model.usage.calls += spent.calls;
    model.usage.cost_usd += T.costOf(cfg.model, spent.input, spent.output);

    // Re-check: the sentence may have been re-edited meanwhile.
    const cur = model.sents.get(sid);
    if (!cur || cur.source !== source || cur.content[source] !== srcHtml) {
      queueWrite(null, true);
      updateCost();
      return;
    }
    const errors = [];
    const plans = {};
    targets.forEach((t, i) => {
      const r = results[i];
      if (r.status === "rejected") {
        errors.push(`${langName(t)}: ${r.reason?.message || r.reason}`);
      } else {
        cur.content[t] = sanitizeInlineHtml(r.value);
        cur.pending = (cur.pending || []).filter((p) => p !== t);
        (plans[t] = plans[t] || new Set()).add(para.pid);
      }
    });
    queueWrite({ paras: plans }, true); // meta carries the updated usage/cost
    applyRemote(renderView(model, lang));
    applyLocalModel();
    if (errors.length) toast(`Some translations failed and will retry on the next edit (${errors[0]})`, true);
  } finally {
    await releaseLock(sid);
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
  applyRemote(renderView(model, lang));
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
      for (const p of model.paras) {
        for (const sid of p.sids) {
          const s = model.sents.get(sid);
          if (!s) continue;
          const srcHtml = s.content[s.source] ?? "";
          if (isShared(p.type, srcHtml)) {
            s.content[code] = srcHtml;
          } else if (s.content[code] === undefined) {
            s.content[code] = srcHtml; // source-text placeholder until translated
            s.pending = s.pending || [];
            if (!s.pending.includes(code)) s.pending.push(code);
            dirty.push(sid);
          }
        }
      }
      const tab = D.tabById(docSnapshot, tabId);
      const requests = [
        ...D.fullTabRewriteRequests(tab, renderTabParas(code)),
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
    model = {
      babel: 3,
      model: T.DEFAULT_MODEL,
      apiKey,
      languages: [{ code, name, tabId: firstTab.tabProperties.tabId }],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 },
      paras: [],
      sents: new Map(),
    };
    for (const para of parsed.paras) {
      const pid = newId();
      const isCode = para.type === "code";
      const clean = isCode ? para.rawHtml : sanitizeInlineHtml(para.rawHtml);
      const parts = isCode ? [clean] : splitSentencesHtml(clean);
      const sids = [];
      for (const h of parts) {
        const sid = newId();
        sids.push(sid);
        model.sents.set(sid, { source: code, content: { [code]: h }, pending: [] });
      }
      model.paras.push({ pid, type: para.type, attrs: para.attrs, sids });
    }
    // Reuse an existing babel:meta tab (e.g. re-setup of an older-format doc).
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
      ...D.fullTabRewriteRequests(langTabFresh, renderTabParas(code)),
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
  els.docName.textContent = docName;
  els.openInDocs.href = `https://docs.google.com/document/d/${docId}/edit`;
  els.readonly.hidden = canEdit;
  if (!view) createEditor();
  lastReceived = new Map();
  await pullDoc();
  if (model) {
    if (!lang || !model.languages.some((l) => l.code === lang)) lang = model.languages[0]?.code;
    updateLangSelect();
    applyRemote(renderView(model, lang));
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
  lockedSids = new Set();
  heldLocks.clear();
  currentIntents = null;
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
