// Babbel Docs frontend: ProseMirror editor + document sidebar + WS sync.
//
// The document model shared with the server is a flat list of blocks:
//   {id, type: paragraph|heading|list_item|blockquote|code, attrs, html}
// where html is inline HTML in the current language. Blocks the user hasn't
// touched are sent without "html" so the server keeps other-language content.

import {
  EditorState, Plugin, PluginKey, TextSelection,
  EditorView, Decoration, DecorationSet,
  Schema, DOMParser as PMDOMParser, DOMSerializer, Slice,
  MarkdownSerializer, MarkdownParser, defaultMarkdownSerializer, defaultMarkdownParser, markdownit,
  basicSchema, addListNodes, splitListItem, liftListItem, sinkListItem, wrapInList as pmWrapInList,
  keymap, baseKeymap, toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode,
  history, undo, redo,
  inputRules, wrappingInputRule, textblockTypeInputRule, undoInputRule,
  dropCursor, gapCursor,
} from "/static/vendor/prosemirror.js";

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

// Default tokens minus nodes our schema doesn't have, plus ~~strikethrough~~.
const mdTokens = { ...defaultMarkdownParser.tokens, s: { mark: "strikethrough" } };
delete mdTokens.hr;
delete mdTokens.image;
const mdParser = new MarkdownParser(schema, markdownit({ html: false }).disable(["hr", "image"]), mdTokens);

const newId = () => crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(16).padStart(8, "0"), "");
const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
// Indent jumps are clamped to one level; a kind change at the same depth
// starts a sibling list. The inner paragraph shares the item's id so the
// block survives a list lift (paragraph becomes top-level, keeps the id).
function buildLists(run) {
  let i = 0;
  const build = (depth) => {
    const kind = run[i].kind;
    const items = []; // {id, content: [paragraph, ...sublists]}
    while (i < run.length && run[i].indent >= depth) {
      if (run[i].indent > depth) {
        if (!items.length) { run[i].indent = depth; continue; } // orphan: clamp
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
  let quote = null; // open blockquote: list of paragraphs
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

// Assign ids to new blocks and re-id duplicates (e.g. after splitting a node).
const idPlugin = new Plugin({
  appendTransaction(transactions, oldState, state) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const seen = new Set();
    let tr = null;
    state.doc.descendants((node, pos) => {
      if (!ID_TYPES.has(node.type.name)) return true;
      // Paragraphs inside list items don't carry the block id; the item does.
      const inItem = node.type.name === "paragraph" &&
        state.doc.resolve(pos).parent.type.name === "list_item";
      if (inItem) return false;
      if (node.attrs.id == null || seen.has(node.attrs.id)) {
        // A freshly wrapped list item adopts its paragraph's id so the block
        // keeps its identity (and translations) across paragraph <-> list.
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

// Highlight blocks whose translation is pending in the current language.
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
        // Paragraphs inside list items share the item's id; decorate the item.
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
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading,
      (m) => ({ level: m[1].length })),
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
  docList: $("doc-list"), newDoc: $("new-doc"), title: $("doc-title"),
  presence: $("presence"), translating: $("translating"), cost: $("cost"),
  langSelect: $("lang-select"), addLang: $("add-lang"),
  addLangPanel: $("add-lang-panel"), addLangInput: $("add-lang-input"),
  addLangConfirm: $("add-lang-confirm"), addLangCancel: $("add-lang-cancel"),
  langCatalog: $("lang-catalog"), exportPdf: $("export-pdf"),
  editorMount: $("editor"), editorScroll: $("editor-scroll"),
  emptyState: $("empty-state"), emptyCreate: $("empty-create"),
  connDot: $("conn-dot"), connText: $("conn-text"), toast: $("toast"),
  toolbar: $("toolbar"),
};

let view = null;
let ws = null;
let currentDoc = null;          // {id, title, languages}
let lang = localStorage.getItem("babbel-lang") || "en";
let lastReceived = new Map();   // block id -> {html, sig} the server has for our lang

const sigOf = (b) => `${b.type}|${JSON.stringify(b.attrs || {})}`;
let sendTimer = null;
let applyingRemote = false;
let skippedRemote = false;
let reconnectTimer = null;
let catalog = [];

function updateCost(usage) {
  if (!usage) { els.cost.hidden = true; return; }
  els.cost.hidden = false;
  els.cost.textContent = `$${usage.cost_usd.toFixed(4)}`;
  els.cost.title = `Claude translation cost for this document\n` +
    `${usage.calls} API calls · ${usage.input_tokens.toLocaleString()} input / ` +
    `${usage.output_tokens.toLocaleString()} output tokens`;
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = isError ? "error" : "";
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}

// --- Editor ----------------------------------------------------------------------

function createEditor() {
  const state = EditorState.create({
    schema,
    plugins: [
      buildInputRules(), buildKeymap(), keymap(baseKeymap),
      dropCursor(), gapCursor(), history(),
      idPlugin, pendingPlugin,
    ],
  });
  view = new EditorView(els.editorMount, {
    state,
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

function hasUnsentChanges() {
  return sendTimer !== null;
}

function sendUpdate() {
  sendTimer = null;
  if (!ws || ws.readyState !== WebSocket.OPEN || !view) return;
  const blocks = docToBlocks(view.state.doc);
  let changed = false;
  const payload = blocks.map((b) => {
    const prev = lastReceived.get(b.id);
    const sig = sigOf(b);
    if (prev && prev.html === b.html) {
      // Text untouched: omit html so the server keeps all translations, but
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
  if (changed || removed || skippedRemote) {
    skippedRemote = false;
    ws.send(JSON.stringify({ type: "update", lang, blocks: payload }));
    // Rebuild lastReceived to drop deleted blocks.
    const ids = new Set(blocks.map((b) => b.id));
    for (const id of [...lastReceived.keys()]) if (!ids.has(id)) lastReceived.delete(id);
  }
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
      view.dispatch(tr.setMeta("addToHistory", false).setMeta(pendingKey, pending));
    } else {
      view.dispatch(view.state.tr.setMeta(pendingKey, pending));
    }
  } finally {
    applyingRemote = false;
  }
  els.translating.hidden = ![...pending.values()].some(Boolean);
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
  view.dispatch(view.state.tr
    .replaceSelection(new Slice(parsed.content, 0, 0))
    .scrollIntoView());
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

// --- WebSocket sync -------------------------------------------------------------------

function setConn(state) {
  els.connDot.className = `dot ${state === "on" ? "on" : state === "off" ? "off" : ""}`;
  els.connText.textContent = state === "on" ? "Connected" : state === "off" ? "Reconnecting…" : "Connecting…";
}

function connect(docId) {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  clearTimeout(reconnectTimer);
  setConn("connecting");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const connLang = lang;
  ws = new WebSocket(`${proto}://${location.host}/ws/${docId}?lang=${encodeURIComponent(connLang)}`);

  ws.onopen = () => setConn("on");

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "init") {
      currentDoc = { ...currentDoc, title: msg.title, languages: msg.languages };
      els.title.value = msg.title;
      renderLangSelect();
      lastReceived = new Map();
      updateCost(msg.usage);
      applyRemote(msg.blocks);
      // renderLangSelect may have fallen back if the remembered language
      // isn't one of this document's languages.
      if (lang !== connLang) ws.send(JSON.stringify({ type: "lang", lang }));
    } else if (msg.type === "doc") {
      applyRemote(msg.blocks);
    } else if (msg.type === "meta") {
      currentDoc = { ...currentDoc, title: msg.title, languages: msg.languages };
      if (document.activeElement !== els.title) els.title.value = msg.title;
      renderLangSelect();
      loadDocList();
    } else if (msg.type === "presence") {
      const parts = Object.entries(msg.users).map(([code, n]) => `${n} ${code}`);
      const total = Object.values(msg.users).reduce((a, b) => a + b, 0);
      els.presence.textContent = total > 1 ? `${total} online (${parts.join(", ")})` : "";
    } else if (msg.type === "usage") {
      updateCost(msg.usage);
    } else if (msg.type === "error") {
      toast(msg.message, true);
    } else if (msg.type === "deleted") {
      toast("This document was deleted");
      currentDoc = null;
      ws.onclose = null; ws.close(); ws = null;
      loadDocList().then(openFirstDoc);
    }
  };

  ws.onclose = () => {
    setConn("off");
    reconnectTimer = setTimeout(() => currentDoc && connect(currentDoc.id), 1500);
  };
}

// --- Documents sidebar ---------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

async function loadDocList() {
  const docs = await api("/api/docs");
  els.docList.innerHTML = "";
  for (const doc of docs) {
    const li = document.createElement("li");
    li.classList.toggle("active", currentDoc?.id === doc.id);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = doc.title;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete document";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.title}"?`)) return;
      await api(`/api/docs/${doc.id}`, { method: "DELETE" });
      if (currentDoc?.id === doc.id) currentDoc = null;
      await loadDocList();
      if (!currentDoc) openFirstDoc();
    };
    li.append(name, del);
    li.onclick = () => openDoc(doc.id);
    els.docList.appendChild(li);
  }
  return docs;
}

function openDoc(docId) {
  if (currentDoc?.id === docId) return;
  clearTimeout(sendTimer); sendTimer = null;
  currentDoc = { id: docId };
  updateCost(null);
  localStorage.setItem("babbel-doc", docId);
  els.emptyState.hidden = true;
  els.editorScroll.hidden = false;
  if (!view) createEditor();
  connect(docId);
  loadDocList();
}

async function openFirstDoc() {
  const docs = await api("/api/docs");
  if (docs.length) {
    openDoc(docs[0].id);
  } else {
    els.emptyState.hidden = false;
    els.editorScroll.hidden = true;
  }
}

async function createDoc() {
  const doc = await api("/api/docs", { method: "POST", body: JSON.stringify({ title: "Untitled" }) });
  await loadDocList();
  openDoc(doc.id);
  els.title.focus();
  els.title.select();
}

// --- Languages -------------------------------------------------------------------------

function renderLangSelect() {
  els.langSelect.innerHTML = "";
  for (const l of currentDoc?.languages || []) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    els.langSelect.appendChild(opt);
  }
  if (![...els.langSelect.options].some((o) => o.value === lang)) {
    lang = currentDoc?.languages?.[0]?.code || "en";
  }
  els.langSelect.value = lang;
}

els.langSelect.onchange = () => {
  flushPendingSend();
  lang = els.langSelect.value;
  localStorage.setItem("babbel-lang", lang);
  lastReceived = new Map();
  ws?.send(JSON.stringify({ type: "lang", lang }));
};

function flushPendingSend() {
  if (sendTimer) { clearTimeout(sendTimer); sendUpdate(); }
}

els.addLang.onclick = async () => {
  els.addLangPanel.hidden = !els.addLangPanel.hidden;
  if (!els.addLangPanel.hidden) {
    if (!catalog.length) {
      catalog = await api("/api/languages");
      els.langCatalog.innerHTML = catalog
        .map((l) => `<option value="${l.name}">${l.code}</option>`).join("");
    }
    els.addLangInput.value = "";
    els.addLangInput.focus();
  }
};
els.addLangCancel.onclick = () => { els.addLangPanel.hidden = true; };
els.addLangConfirm.onclick = addLanguage;
els.addLangInput.onkeydown = (e) => { if (e.key === "Enter") addLanguage(); };

async function addLanguage() {
  const raw = els.addLangInput.value.trim();
  if (!raw || !currentDoc) return;
  let entry = catalog.find((l) => l.name.toLowerCase() === raw.toLowerCase() || l.code === raw.toLowerCase());
  const body = entry || { code: raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8), name: raw };
  try {
    await api(`/api/docs/${currentDoc.id}/languages`, { method: "POST", body: JSON.stringify(body) });
    els.addLangPanel.hidden = true;
    toast(`Added ${body.name} — translating existing content…`);
  } catch (err) {
    toast(err.message, true);
  }
}

// --- Misc UI -----------------------------------------------------------------------------

els.newDoc.onclick = createDoc;
els.emptyCreate.onclick = createDoc;

let titleTimer = null;
els.title.addEventListener("input", () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    ws?.send(JSON.stringify({ type: "title", title: els.title.value }));
    loadDocList();
  }, 400);
});

els.exportPdf.onclick = () => {
  if (!currentDoc) return;
  flushPendingSend();
  window.open(`/api/docs/${currentDoc.id}/export.pdf?lang=${encodeURIComponent(lang)}`, "_blank");
};

// Console/debug access to the markdown converters.
window.babbel = { toMarkdown: () => mdSerializer.serialize(view.state.doc), insertMarkdown };

// --- Boot --------------------------------------------------------------------------------

(async function boot() {
  const docs = await loadDocList();
  const remembered = localStorage.getItem("babbel-doc");
  if (remembered && docs.some((d) => d.id === remembered)) openDoc(remembered);
  else if (docs.length) openDoc(docs[0].id);
  else { els.emptyState.hidden = false; els.editorScroll.hidden = true; }
})();
