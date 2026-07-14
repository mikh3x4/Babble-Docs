// Conversion between our block model and Google Docs tabs — storage format v2.
//
// The Google Doc is the database, with no duplicated content:
//   - One tab per language holds the rendered, human-readable document.
//     Every block is exactly one paragraph; soft line breaks (\v) stand
//     in for <br>.
//   - Block identity AND sync state live in invisible named ranges:
//         babel:<id>:<ownHash>:<srcHash>
//     ownHash = hash of this block's content in this tab when the app last
//     wrote it. actual-vs-ownHash mismatch => text was edited outside the
//     app (or a client died mid-write) => reconcile (the expensive path).
//     srcHash = hash of the source-language content this translation was
//     made from. srcHash != the source tab's actual hash => translation is
//     stale (pending). own == src marks the block's source language.
//   - A tab named `babel:meta` holds only config: languages<->tabIds, the
//     Anthropic API key, the model, and usage/cost counters.
//
// Hashes are computed over a canonical form (type | attrs | canonical inline
// HTML) so that Docs run-splitting and tag-ordering differences never look
// like edits. All parsing goes through the same canonicalization.
//
// Docs encoding of block types:
//   heading    -> namedStyleType HEADING_1..3
//   list_item  -> real Docs bullets (nesting = bullet nestingLevel)
//   blockquote -> indentStart 36pt
//   code       -> paragraph shading (light gray) + Courier New
//   inline code-> Courier New runs inside an unshaded paragraph

import { escapeHtml } from "./core.js";

export const META_TAB_TITLE = "babel:meta";
export const STALE_HASH = "00000000"; // srcHash that never matches: forces retranslation
const RANGE_PREFIX = "babel:";
const CODE_FONT = "Courier New";
const GRAY = { color: { rgbColor: { red: 0.956, green: 0.96, blue: 0.97 } } };

// --- Hashing --------------------------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const stableStringify = (obj) =>
  JSON.stringify(obj || {}, Object.keys(obj || {}).sort());

export function blockHash(type, attrs, html) {
  const body = type === "code" ? html : canonicalInline(html);
  return fnv1a(`${type}|${stableStringify(attrs)}|${body}`);
}

export const rangeName = (id, own, src) => `${RANGE_PREFIX}${id}:${own}:${src}`;

export function parseRangeName(name) {
  if (!name.startsWith(RANGE_PREFIX)) return null;
  const [id, own, src] = name.slice(RANGE_PREFIX.length).split(":");
  return { id, own: own || null, src: src || null };
}

// --- Tab discovery -----------------------------------------------------------

export function flattenTabs(doc) {
  const out = [];
  const walk = (tabs) => {
    for (const t of tabs || []) {
      out.push(t);
      walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  return out;
}

export function findMetaTab(doc) {
  return flattenTabs(doc).find((t) => t.tabProperties.title === META_TAB_TITLE) || null;
}

export function tabById(doc, tabId) {
  return flattenTabs(doc).find((t) => t.tabProperties.tabId === tabId) || null;
}

export function tabText(tab) {
  const parts = [];
  for (const el of tab.documentTab.body.content || []) {
    if (!el.paragraph) continue;
    for (const pe of el.paragraph.elements || []) {
      if (pe.textRun) parts.push(pe.textRun.content);
    }
  }
  return parts.join("");
}

export function bodyEndIndex(tab) {
  const content = tab.documentTab.body.content || [];
  return content.length ? content[content.length - 1].endIndex : 2;
}

// --- Meta tab (config only) ------------------------------------------------------

export function parseMeta(tab) {
  const text = tabText(tab).trim();
  if (!text) return null;
  try {
    const meta = JSON.parse(text);
    return meta && meta.babel ? meta : null;
  } catch {
    return null;
  }
}

export function metaRewriteRequests(tab, meta) {
  const tabId = tab.tabProperties.tabId;
  const end = bodyEndIndex(tab);
  const text = JSON.stringify(meta, null, 1);
  const requests = [];
  if (end - 1 > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  }
  requests.push({ insertText: { location: { index: 1, tabId }, text } });
  return requests;
}

// --- Styled segments: the canonical inline representation ---------------------------
// A segment is {text, style:{bold,italic,underline,strike,code,link}}. Both the
// HTML side (editor/model) and the Docs side (textRuns) reduce to segments;
// canonical HTML is emitted from merged segments with a fixed tag order, so
// equivalent content always produces identical bytes (and identical hashes).

function segmentsFromHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const segments = [];
  const walk = (node, style) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) segments.push({ text: child.textContent, style });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === "br") { segments.push({ text: "\u000b", style }); continue; }
        const s = { ...style };
        if (tag === "strong" || tag === "b") s.bold = true;
        else if (tag === "em" || tag === "i") s.italic = true;
        else if (tag === "u") s.underline = true;
        else if (tag === "s" || tag === "del") s.strike = true;
        else if (tag === "code") s.code = true;
        else if (tag === "a") {
          const href = child.getAttribute("href") || "";
          if (/^https?:\/\//.test(href)) s.link = href;
        }
        walk(child, s);
      }
    }
  };
  walk(div, {});
  return segments;
}

function segmentsFromRuns(runs) {
  const segments = [];
  for (const run of runs) {
    const ts = run.textStyle || {};
    const text = run.content.replace(/\n$/, "");
    if (!text) continue;
    const style = {};
    if (ts.bold) style.bold = true;
    if (ts.italic) style.italic = true;
    if (ts.underline && !ts.link) style.underline = true;
    if (ts.strikethrough) style.strike = true;
    if ((ts.weightedFontFamily?.fontFamily || "").includes("Courier")) style.code = true;
    if (ts.link?.url && /^https?:\/\//.test(ts.link.url)) style.link = ts.link.url;
    segments.push({ text, style });
  }
  return segments;
}

const styleKey = (s) =>
  `${s.bold ? "b" : ""}${s.italic ? "i" : ""}${s.underline ? "u" : ""}${s.strike ? "s" : ""}${s.code ? "c" : ""}|${s.link || ""}`;

function mergeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && styleKey(last.style) === styleKey(seg.style)) last.text += seg.text;
    else out.push({ text: seg.text, style: { ...seg.style } });
  }
  return out;
}

function htmlFromSegments(segments) {
  // Fixed nesting order: a > strong > em > u > s > code (innermost).
  return segments.map(({ text, style }) => {
    let html = escapeHtml(text).replace(/\u000b/g, "<br>");
    if (style.code) html = `<code>${html}</code>`;
    if (style.strike) html = `<s>${html}</s>`;
    if (style.underline) html = `<u>${html}</u>`;
    if (style.italic) html = `<em>${html}</em>`;
    if (style.bold) html = `<strong>${html}</strong>`;
    if (style.link) html = `<a href="${escapeHtml(style.link)}">${html}</a>`;
    return html;
  }).join("");
}

export const canonicalInline = (html) =>
  htmlFromSegments(mergeSegments(segmentsFromHtml(html)));

function textStyleFor(style, isCodeBlock) {
  const ts = {};
  const fields = [];
  if (style.bold) { ts.bold = true; fields.push("bold"); }
  if (style.italic) { ts.italic = true; fields.push("italic"); }
  if (style.underline) { ts.underline = true; fields.push("underline"); }
  if (style.strike) { ts.strikethrough = true; fields.push("strikethrough"); }
  if (style.link) { ts.link = { url: style.link }; fields.push("link"); }
  if (style.code && !isCodeBlock) {
    ts.weightedFontFamily = { fontFamily: CODE_FONT };
    ts.backgroundColor = GRAY;
    fields.push("weightedFontFamily", "backgroundColor");
  }
  return fields.length ? { textStyle: ts, fields: fields.join(",") } : null;
}

// --- Blocks -> Docs requests ---------------------------------------------------------

function blockRenderPlan(block) {
  let segments;
  if (block.type === "code") {
    const div = document.createElement("div");
    div.innerHTML = block.html;
    segments = [{ text: div.textContent.replace(/\n/g, "\u000b"), style: {} }];
  } else {
    segments = mergeSegments(segmentsFromHtml(block.html));
  }
  const indentTabs = block.type === "list_item" ? Math.max(Math.floor(block.attrs?.indent) || 0, 0) : 0;
  const prefix = "\t".repeat(indentTabs);
  let offset = prefix.length;
  const styleRuns = [];
  for (const seg of segments) {
    if (seg.text.length && Object.keys(seg.style).length) {
      styleRuns.push({ offset, length: seg.text.length, style: seg.style });
    }
    offset += seg.text.length;
  }
  return { text: prefix + segments.map((s) => s.text).join(""), styleRuns };
}

function paragraphStyleRequest(block, range) {
  const ps = {};
  let named = "NORMAL_TEXT";
  if (block.type === "heading") {
    named = `HEADING_${Math.min(Math.max(block.attrs?.level || 1, 1), 3)}`;
  }
  ps.namedStyleType = named;
  if (block.type === "blockquote") ps.indentStart = { magnitude: 36, unit: "PT" };
  if (block.type === "code") ps.shading = { backgroundColor: GRAY };
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: ps,
      fields: "namedStyleType,indentStart,indentFirstLine,shading",
    },
  };
}

const RESET_FIELDS = "bold,italic,underline,strikethrough,link,weightedFontFamily,backgroundColor";

export function fullTabRewriteRequests(tab, blocks, nameFor) {
  // Replace a language tab's entire body with the rendered blocks and fresh
  // named ranges (nameFor(block) supplies babel:<id>:<own>:<src>).
  const tabId = tab.tabProperties.tabId;
  const requests = [];

  for (const name of Object.keys(tab.documentTab.namedRanges || {})) {
    if (name.startsWith("babel")) { // covers babel: and old babelp: ranges
      requests.push({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } });
    }
  }
  const end = bodyEndIndex(tab);
  if (end - 1 > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  }
  if (!blocks.length) return requests;

  const plans = blocks.map(blockRenderPlan);
  const fullText = plans.map((p) => p.text).join("\n");
  requests.push({ insertText: { location: { index: 1, tabId }, text: fullText } });
  // The surviving final paragraph keeps its old paragraph properties — if it
  // was a list item, every inserted paragraph inherits its bullet and the
  // whole document turns into one list. Strip inherited bullets first;
  // legitimate list runs are recreated below.
  requests.push({ deleteParagraphBullets: {
    range: { startIndex: 1, endIndex: 1 + fullText.length, tabId },
  } });

  let pos = 1;
  const spans = plans.map((p) => {
    const start = pos;
    pos += p.text.length + 1;
    return { start, end: start + p.text.length };
  });

  const bulletRuns = [];
  blocks.forEach((block, i) => {
    const { start, end: contentEnd } = spans[i];
    const styleRange = { startIndex: start, endIndex: Math.max(contentEnd, start + 1), tabId };
    requests.push(paragraphStyleRequest(block, styleRange));
    if (contentEnd > start) {
      requests.push({ updateTextStyle: { range: { startIndex: start, endIndex: contentEnd, tabId }, textStyle: {}, fields: RESET_FIELDS } });
      if (block.type === "code") {
        requests.push({ updateTextStyle: {
          range: { startIndex: start, endIndex: contentEnd, tabId },
          textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
          fields: "weightedFontFamily",
        } });
      }
    }
    for (const run of plans[i].styleRuns) {
      const req = textStyleFor(run.style, block.type === "code");
      if (req) {
        requests.push({ updateTextStyle: {
          range: { startIndex: start + run.offset, endIndex: start + run.offset + run.length, tabId },
          ...req,
        } });
      }
    }
    const nrEnd = i === blocks.length - 1 ? 1 + fullText.length + 1 : spans[i + 1].start;
    requests.push({ createNamedRange: {
      name: nameFor(block),
      range: { startIndex: start, endIndex: nrEnd, tabId },
    } });
    if (block.type === "list_item") {
      const ordered = block.attrs?.list === "ordered";
      const last = bulletRuns[bulletRuns.length - 1];
      if (last && last.ordered === ordered && last.endBlock === i - 1) {
        last.end = contentEnd; last.endBlock = i;
      } else {
        bulletRuns.push({ start, end: contentEnd, ordered, endBlock: i });
      }
    }
  });

  // createParagraphBullets consumes the leading tabs (shifting later indices),
  // so bullet requests go last, bottom-up.
  for (const run of bulletRuns.reverse()) {
    requests.push({ createParagraphBullets: {
      range: { startIndex: run.start, endIndex: Math.max(run.end, run.start + 1), tabId },
      bulletPreset: run.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
    } });
  }
  return requests;
}

export function singleBlockRewriteRequests(tab, block, span, name, oldNames) {
  // Content-only rewrite of one block inside its existing paragraph. `span` is
  // the block's current named-range span [start, end) (newline included).
  // Keeps paragraph-level style and bullets; replaces text, inline styles, and
  // the named range (whose name carries the new hashes).
  const tabId = tab.tabProperties.tabId;
  const [start, end] = span;
  const requests = [];
  const plan = blockRenderPlan({ ...block, attrs: { ...block.attrs, indent: 0 } }); // no tabs: bullet already set
  if (end - 1 > start) {
    requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: end - 1, tabId } } });
  }
  if (plan.text.length) {
    requests.push({ insertText: { location: { index: start, tabId }, text: plan.text } });
    requests.push({ updateTextStyle: {
      range: { startIndex: start, endIndex: start + plan.text.length, tabId },
      textStyle: {}, fields: RESET_FIELDS,
    } });
    if (block.type === "code") {
      requests.push({ updateTextStyle: {
        range: { startIndex: start, endIndex: start + plan.text.length, tabId },
        textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
        fields: "weightedFontFamily",
      } });
    }
    for (const run of plan.styleRuns) {
      const req = textStyleFor(run.style, block.type === "code");
      if (req) {
        requests.push({ updateTextStyle: {
          range: { startIndex: start + run.offset, endIndex: start + run.offset + run.length, tabId },
          ...req,
        } });
      }
    }
  }
  for (const old of oldNames || []) {
    requests.push({ deleteNamedRange: { name: old, tabsCriteria: { tabIds: [tabId] } } });
  }
  requests.push({ createNamedRange: {
    name,
    range: { startIndex: start, endIndex: start + plan.text.length + 1, tabId },
  } });
  return requests;
}

// --- Docs tab -> blocks -----------------------------------------------------------

export function parseLanguageTab(tab) {
  // Returns {blocks, spans}. Each block: {id|null, own|null, src|null, name,
  // type, attrs, html (canonical), hash (actual)}; spans: id -> [s, e).
  const documentTab = tab.documentTab;
  const lists = documentTab.lists || {};

  // babel named ranges: id -> {name, own, src, spans:[[s,e)...]}
  const rangesById = new Map();
  for (const [name, group] of Object.entries(documentTab.namedRanges || {})) {
    const parsed = parseRangeName(name);
    if (!parsed) continue;
    for (const nr of group.namedRanges || []) {
      for (const r of nr.ranges || []) {
        if (!rangesById.has(parsed.id)) rangesById.set(parsed.id, { ...parsed, name, spans: [] });
        rangesById.get(parsed.id).spans.push([r.startIndex ?? 0, r.endIndex]);
      }
    }
  }
  const rangeAt = (index) => {
    for (const info of rangesById.values()) {
      for (const [s, e] of info.spans) if (index >= s && index < e) return info;
    }
    return null;
  };

  const blocks = [];
  const spans = new Map();
  const usedIds = new Set();
  for (const el of documentTab.body.content || []) {
    if (!el.paragraph) continue;
    const p = el.paragraph;
    const ps = p.paragraphStyle || {};
    const runs = (p.elements || []).filter((pe) => pe.textRun).map((pe) => pe.textRun);
    const plain = runs.map((r) => r.content).join("").replace(/\n$/, "");

    let type = "paragraph", attrs = {};
    const named = ps.namedStyleType || "NORMAL_TEXT";
    const shaded = !!ps.shading?.backgroundColor?.color;
    if (p.bullet) {
      const level = p.bullet.nestingLevel || 0;
      const glyph = lists[p.bullet.listId]?.listProperties?.nestingLevels?.[level] || {};
      const ordered = !!glyph.glyphType && glyph.glyphType !== "GLYPH_TYPE_UNSPECIFIED" && glyph.glyphType !== "NONE";
      type = "list_item";
      attrs = { list: ordered ? "ordered" : "bullet", indent: level };
    } else if (/^HEADING_[1-6]$/.test(named)) {
      type = "heading";
      attrs = { level: Math.min(parseInt(named.slice(8), 10), 3) };
    } else if (shaded) {
      type = "code";
    } else if ((ps.indentStart?.magnitude || 0) >= 18) {
      type = "blockquote";
    }
    const html = type === "code"
      ? escapeHtml(plain.replace(/\u000b/g, "\n"))
      : htmlFromSegments(mergeSegments(segmentsFromRuns(runs)));

    const info = rangeAt(el.startIndex);
    let id = info && !usedIds.has(info.id) ? info.id : null;
    if (id) {
      usedIds.add(id);
      spans.set(id, [el.startIndex, el.endIndex]);
    }
    blocks.push({
      id,
      own: id ? info.own : null,
      src: id ? info.src : null,
      name: id ? info.name : null,
      type, attrs, html,
      hash: blockHash(type, attrs, html),
    });
  }
  // Drop a single trailing unregistered empty paragraph (Docs' mandatory final
  // newline shows up as one when the last block's named range got clipped).
  const last = blocks[blocks.length - 1];
  if (blocks.length && !last.id && !last.html) blocks.pop();
  return { blocks, spans };
}
