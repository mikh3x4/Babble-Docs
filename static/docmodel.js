// Conversion between the two-tier model and Google Docs tabs — storage v3.
//
// The Google Doc is the database, with no duplicated content:
//   - One tab per language; every PARAGRAPH block is one Docs paragraph
//     (heading/list/quote/code styling as before).
//   - Paragraph identity + structure: invisible named range
//         babelp:<pid>:<attrsHash>        (attrsHash = hash(type|attrs))
//     spanning the paragraph. attrsHash mismatch vs the parsed style means
//     the paragraph was restyled outside the app.
//   - SENTENCES are the sync unit. Each sentence's span carries
//         babel:<sid>:<ownHash>:<srcHash>
//     ownHash = hash of the sentence text at last app write (actual-vs-own
//     mismatch, or text not covered by sentence ranges => external edit =>
//     reconcile). srcHash = hash of the source-language sentence this
//     translation was made from (mismatch vs the source's actual hash =>
//     stale => pending). own == src marks the sentence's source language.
//   - Segmentation in translated tabs is DEFINED by the ranges — sentence
//     heuristics only ever run on the language being edited, so CJK
//     punctuation or model output never break alignment.
//   - A tab named `babel:meta` holds only config: languages<->tabIds, the
//     Anthropic API key, the model, and usage/cost counters.

import { escapeHtml } from "./core.js";

export const META_TAB_TITLE = "babel:meta";
export const STALE_HASH = "00000000"; // srcHash that never matches: forces retranslation
const SENT_PREFIX = "babel:";
const PARA_PREFIX = "babelp:";
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

const stableStringify = (obj) => JSON.stringify(obj || {}, Object.keys(obj || {}).sort());

export const sentHash = (html) => fnv1a(canonicalInline(html));
export const codeHash = (html) => fnv1a(String(html || ""));
export const attrsHash = (type, attrs) => fnv1a(`${type}|${stableStringify(attrs)}`);

export const sentRangeName = (sid, own, src) => `${SENT_PREFIX}${sid}:${own}:${src}`;
export const paraRangeName = (pid, ah) => `${PARA_PREFIX}${pid}:${ah}`;

export function parseSentRangeName(name) {
  if (!name.startsWith(SENT_PREFIX) || name.startsWith(PARA_PREFIX)) return null;
  const [sid, own, src] = name.slice(SENT_PREFIX.length).split(":");
  return sid && own && src ? { sid, own, src } : null;
}

export function parseParaRangeName(name) {
  if (!name.startsWith(PARA_PREFIX)) return null;
  const [pid, ah] = name.slice(PARA_PREFIX.length).split(":");
  return pid ? { pid, ah: ah || null } : null;
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

// --- Styled segments: canonical inline representation ---------------------------

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

// --- Rendering: paragraph pieces -> text + style runs --------------------------------
// A render paragraph is {pid, type, attrs, pieces: [{sid, html, own, src}]}.
// Pieces concatenate into one Docs paragraph; each piece gets a sentence range.

function pieceSegments(piece, isCode) {
  if (isCode) {
    const div = document.createElement("div");
    div.innerHTML = piece.html;
    return [{ text: div.textContent.replace(/\n/g, "\u000b"), style: {} }];
  }
  return mergeSegments(segmentsFromHtml(piece.html));
}

function paraRenderPlan(para, withIndent) {
  const isCode = para.type === "code";
  const indent = para.type === "list_item" ? Math.max(Math.floor(para.attrs?.indent) || 0, 0) : 0;
  const prefix = withIndent ? "\t".repeat(indent) : "";
  let offset = prefix.length;
  const styleRuns = [];
  const pieceSpans = []; // {sid, own, src, start, end} offsets within paragraph text
  let text = prefix;
  for (const piece of para.pieces) {
    const segs = pieceSegments(piece, isCode);
    const pieceStart = offset;
    for (const seg of segs) {
      if (seg.text.length && Object.keys(seg.style).length) {
        styleRuns.push({ offset, length: seg.text.length, style: seg.style });
      }
      offset += seg.text.length;
      text += seg.text;
    }
    pieceSpans.push({ sid: piece.sid, own: piece.own, src: piece.src, start: pieceStart, end: offset });
  }
  return { text, styleRuns, pieceSpans, isCode };
}

function paragraphStyleRequest(para, range) {
  const ps = {};
  let named = "NORMAL_TEXT";
  if (para.type === "heading") {
    named = `HEADING_${Math.min(Math.max(para.attrs?.level || 1, 1), 3)}`;
  }
  ps.namedStyleType = named;
  if (para.type === "blockquote") ps.indentStart = { magnitude: 36, unit: "PT" };
  if (para.type === "code") ps.shading = { backgroundColor: GRAY };
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: ps,
      fields: "namedStyleType,indentStart,indentFirstLine,shading",
    },
  };
}

const RESET_FIELDS = "bold,italic,underline,strikethrough,link,weightedFontFamily,backgroundColor";

function inlineStyleRequests(tabId, base, plan) {
  const requests = [];
  const contentLen = plan.text.length;
  if (contentLen) {
    requests.push({ updateTextStyle: {
      range: { startIndex: base, endIndex: base + contentLen, tabId },
      textStyle: {}, fields: RESET_FIELDS,
    } });
    if (plan.isCode) {
      requests.push({ updateTextStyle: {
        range: { startIndex: base, endIndex: base + contentLen, tabId },
        textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
        fields: "weightedFontFamily",
      } });
    }
  }
  for (const run of plan.styleRuns) {
    const req = textStyleFor(run.style, plan.isCode);
    if (req) {
      requests.push({ updateTextStyle: {
        range: { startIndex: base + run.offset, endIndex: base + run.offset + run.length, tabId },
        ...req,
      } });
    }
  }
  return requests;
}

function rangeRequests(tabId, base, para, plan, paraEnd) {
  // paraEnd = index just past the paragraph's trailing newline.
  const requests = [];
  requests.push({ createNamedRange: {
    name: paraRangeName(para.pid, attrsHash(para.type, para.attrs)),
    range: { startIndex: base, endIndex: paraEnd, tabId },
  } });
  for (const ps of plan.pieceSpans) {
    if (ps.end > ps.start) {
      requests.push({ createNamedRange: {
        name: sentRangeName(ps.sid, ps.own, ps.src),
        range: { startIndex: base + ps.start, endIndex: base + ps.end, tabId },
      } });
    }
  }
  return requests;
}

export function fullTabRewriteRequests(tab, paras) {
  const tabId = tab.tabProperties.tabId;
  const requests = [];
  for (const name of Object.keys(tab.documentTab.namedRanges || {})) {
    if (name.startsWith(SENT_PREFIX) || name.startsWith(PARA_PREFIX)) {
      requests.push({ deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } } });
    }
  }
  const end = bodyEndIndex(tab);
  if (end - 1 > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  }
  if (!paras.length) return requests;

  const plans = paras.map((p) => paraRenderPlan(p, true));
  const fullText = plans.map((p) => p.text).join("\n");
  requests.push({ insertText: { location: { index: 1, tabId }, text: fullText } });

  let pos = 1;
  const bulletRuns = [];
  paras.forEach((para, i) => {
    const plan = plans[i];
    const start = pos;
    const contentEnd = start + plan.text.length;
    const paraEnd = i === paras.length - 1 ? 1 + fullText.length + 1 : contentEnd + 1;
    pos = contentEnd + 1;

    requests.push(paragraphStyleRequest(para, {
      startIndex: start, endIndex: Math.max(contentEnd, start + 1), tabId,
    }));
    requests.push(...inlineStyleRequests(tabId, start, plan));
    requests.push(...rangeRequests(tabId, start, para, plan, paraEnd));

    if (para.type === "list_item") {
      const ordered = para.attrs?.list === "ordered";
      const last = bulletRuns[bulletRuns.length - 1];
      if (last && last.ordered === ordered && last.endPara === i - 1) {
        last.end = contentEnd; last.endPara = i;
      } else {
        bulletRuns.push({ start, end: contentEnd, ordered, endPara: i });
      }
    }
  });

  // createParagraphBullets consumes the leading tabs (shifting later indices),
  // so bullet requests go last, bottom-up. Named ranges shrink automatically.
  for (const run of bulletRuns.reverse()) {
    requests.push({ createParagraphBullets: {
      range: { startIndex: run.start, endIndex: Math.max(run.end, run.start + 1), tabId },
      bulletPreset: run.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
    } });
  }
  return requests;
}

export function paraRewriteRequests(tab, parsedPara, para) {
  // Content-only rewrite of one paragraph (type/attrs unchanged — structural
  // changes go through full rewrites). Replaces text, inline styles, and all
  // of the paragraph's ranges with exact recomputed spans.
  const tabId = tab.tabProperties.tabId;
  const [pStart, pEnd] = parsedPara.span; // [start, end) incl. trailing newline
  const requests = [];
  const plan = paraRenderPlan(para, false); // bullets already applied; no tab prefix
  if (pEnd - 1 > pStart) {
    requests.push({ deleteContentRange: { range: { startIndex: pStart, endIndex: pEnd - 1, tabId } } });
  }
  if (plan.text.length) {
    requests.push({ insertText: { location: { index: pStart, tabId }, text: plan.text } });
    requests.push(...inlineStyleRequests(tabId, pStart, plan));
  }
  for (const old of parsedPara.rangeNames || []) {
    requests.push({ deleteNamedRange: { name: old, tabsCriteria: { tabIds: [tabId] } } });
  }
  requests.push(...rangeRequests(tabId, pStart, para, plan, pStart + plan.text.length + 1));
  return requests;
}

// --- Docs tab -> parsed paragraphs -------------------------------------------------

function runSegmentsAbs(runs) {
  // Absolute-position styled segments: [{start, end, text, style}]
  const out = [];
  for (const pe of runs) {
    const run = pe.textRun;
    const text = run.content.replace(/\n$/, "");
    if (!text) continue;
    const ts = run.textStyle || {};
    const style = {};
    if (ts.bold) style.bold = true;
    if (ts.italic) style.italic = true;
    if (ts.underline && !ts.link) style.underline = true;
    if (ts.strikethrough) style.strike = true;
    if ((ts.weightedFontFamily?.fontFamily || "").includes("Courier")) style.code = true;
    if (ts.link?.url && /^https?:\/\//.test(ts.link.url)) style.link = ts.link.url;
    out.push({ start: pe.startIndex, end: pe.startIndex + text.length, text, style });
  }
  return out;
}

function sliceSegments(segsAbs, s, e) {
  const out = [];
  for (const seg of segsAbs) {
    const a = Math.max(seg.start, s), b = Math.min(seg.end, e);
    if (b > a) out.push({ text: seg.text.slice(a - seg.start, b - seg.start), style: seg.style });
  }
  return out;
}

export function parseLanguageTab(tab) {
  // Returns {paras, dirty}. Each para: {pid|null, type, attrs, span:[s,e),
  // rangeNames, rawHtml, sents:[{sid, own, src, html, hash}], broken}.
  // A paragraph is broken when its text isn't exactly covered, in order, by
  // consistent sentence ranges — i.e. someone edited it outside the app.
  const documentTab = tab.documentTab;
  const lists = documentTab.lists || {};

  const sentRanges = [];  // {sid, own, src, name, s, e}
  const paraRanges = [];  // {pid, ah, name, s, e}
  for (const [name, group] of Object.entries(documentTab.namedRanges || {})) {
    const pr = parseParaRangeName(name);
    const sr = pr ? null : parseSentRangeName(name);
    if (!pr && !sr) continue;
    for (const nr of group.namedRanges || []) {
      for (const r of nr.ranges || []) {
        const span = { s: r.startIndex ?? 0, e: r.endIndex, name };
        if (pr) paraRanges.push({ ...pr, ...span });
        else sentRanges.push({ ...sr, ...span });
      }
    }
  }
  sentRanges.sort((a, b) => a.s - b.s);

  const paras = [];
  const usedPids = new Set();
  const usedSids = new Set();
  for (const el of documentTab.body.content || []) {
    if (!el.paragraph) continue;
    const p = el.paragraph;
    const ps = p.paragraphStyle || {};
    const runs = (p.elements || []).filter((pe) => pe.textRun);
    const segsAbs = runSegmentsAbs(runs);
    const pStart = el.startIndex, pEnd = el.endIndex;
    const contentEnd = pEnd - 1;

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
    const isCode = type === "code";
    const plain = runs.map((pe) => pe.textRun.content).join("").replace(/\n$/, "");
    const rawHtml = isCode
      ? escapeHtml(plain.replace(/\u000b/g, "\n"))
      : htmlFromSegments(mergeSegments(sliceSegments(segsAbs, pStart, contentEnd)));

    const pr = paraRanges.find((r) => pStart >= r.s && pStart < r.e && !usedPids.has(r.pid));
    const pid = pr ? pr.pid : null;
    if (pid) usedPids.add(pid);
    const attrsOk = pr ? pr.ah === attrsHash(type, attrs) : false;

    // Sentence ranges inside this paragraph, in order.
    const inPara = sentRanges.filter((r) =>
      r.s >= pStart && r.s < contentEnd && !usedSids.has(r.sid));
    const sents = [];
    let broken = !pr || !attrsOk;
    let cursor = pStart;
    for (const r of inPara) {
      if (r.s !== cursor) broken = true; // gap or overlap
      const end = Math.min(r.e, contentEnd);
      const html = isCode
        ? escapeHtml(plain.slice(r.s - pStart, end - pStart).replace(/\u000b/g, "\n"))
        : htmlFromSegments(mergeSegments(sliceSegments(segsAbs, r.s, end)));
      const hash = isCode ? codeHash(html) : sentHash(html);
      if (r.own !== hash) broken = true;
      sents.push({ sid: r.sid, own: r.own, src: r.src, html, hash });
      usedSids.add(r.sid);
      cursor = end;
    }
    if (cursor !== contentEnd) broken = true; // uncovered trailing text
    if (contentEnd === pStart && !inPara.length) broken = !pid; // empty para ok if identified

    paras.push({
      pid, type, attrs,
      span: [pStart, pEnd],
      rangeNames: [...(pr ? [pr.name] : []), ...inPara.map((r) => r.name)],
      rawHtml, sents, broken,
    });
  }
  // Drop a trailing empty unidentified paragraph (the mandatory final newline).
  const last = paras[paras.length - 1];
  if (paras.length && !last.pid && !last.rawHtml) paras.pop();
  return { paras, dirty: paras.some((p) => p.broken) };
}
