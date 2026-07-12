// Conversion between our block model and Google Docs tabs.
//
// Layout convention inside the Google Doc (the "database"):
//   - One tab named `babel:meta` holds a JSON blob: languages, API key, model,
//     usage counters, and the canonical block model (content per language,
//     pending flags, sentence history). Humans can read it; the app owns it.
//   - One tab per language holds the rendered, human-readable document.
//     Every block is exactly one paragraph; soft line breaks (\v) stand in for
//     <br>. Each block's identity is tracked with a named range `babel:<id>`
//     so blocks keep their ids (and translations) across edits.
//
// Docs encoding of block types:
//   heading    -> namedStyleType HEADING_1..3
//   list_item  -> real Docs bullets (nesting = bullet nestingLevel)
//   blockquote -> indentStart 36pt
//   code       -> paragraph shading (light gray) + Courier New
//   inline code-> Courier New runs inside an unshaded paragraph

import { escapeHtml, newId } from "./core.js";

export const META_TAB_TITLE = "babel:meta";
const RANGE_PREFIX = "babel:";
const CODE_FONT = "Courier New";
const GRAY = { color: { rgbColor: { red: 0.956, green: 0.96, blue: 0.97 } } };

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
  // All plain text in a tab, paragraphs joined with \n.
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

// --- Meta tab ------------------------------------------------------------------

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

// --- Inline HTML -> styled segments ------------------------------------------------

function inlineToSegments(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const segments = []; // {text, style:{bold,italic,underline,strike,code,link}}
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
        else if (tag === "a") s.link = child.getAttribute("href") || null;
        walk(child, s);
      }
    }
  };
  walk(div, {});
  return segments;
}

function segmentsText(segments) {
  return segments.map((s) => s.text).join("");
}

function textStyleFor(style, isCodeBlock) {
  const ts = {};
  const fields = [];
  if (style.bold) { ts.bold = true; fields.push("bold"); }
  if (style.italic) { ts.italic = true; fields.push("italic"); }
  if (style.underline) { ts.underline = true; fields.push("underline"); }
  if (style.strike) { ts.strikethrough = true; fields.push("strikethrough"); }
  if (style.link && /^https?:\/\//.test(style.link)) { ts.link = { url: style.link }; fields.push("link"); }
  if (style.code && !isCodeBlock) {
    ts.weightedFontFamily = { fontFamily: CODE_FONT };
    ts.backgroundColor = GRAY;
    fields.push("weightedFontFamily", "backgroundColor");
  }
  return fields.length ? { textStyle: ts, fields: fields.join(",") } : null;
}

// --- Blocks -> Docs requests ---------------------------------------------------------

function blockRenderPlan(block) {
  // Returns {text, styleRuns:[{offset, length, style}], indentTabs}
  let segments;
  if (block.type === "code") {
    const div = document.createElement("div");
    div.innerHTML = block.html;
    segments = [{ text: div.textContent.replace(/\n/g, "\u000b"), style: {} }];
  } else {
    segments = inlineToSegments(block.html);
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
  return { text: prefix + segmentsText(segments), styleRuns, indentTabs };
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

export function fullTabRewriteRequests(tab, blocks) {
  // Replace a language tab's entire body with the rendered blocks and fresh
  // babel:<id> named ranges. All indices are computed against the state the
  // tab will be in after the preceding requests in this same batch.
  const tabId = tab.tabProperties.tabId;
  const requests = [];

  for (const name of Object.keys(tab.documentTab.namedRanges || {})) {
    if (name.startsWith(RANGE_PREFIX)) {
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

  // Per-block spans within the inserted text (before bullets eat the tabs).
  let pos = 1;
  const spans = plans.map((p) => {
    const start = pos;
    pos += p.text.length + 1; // + newline
    return { start, end: start + p.text.length }; // content span, excl. newline
  });

  const bulletRuns = []; // {start, end, ordered}
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
    // Named range includes the trailing newline so it survives content rewrites.
    const nrEnd = i === blocks.length - 1 ? 1 + fullText.length + 1 : spans[i + 1].start;
    requests.push({ createNamedRange: {
      name: RANGE_PREFIX + block.id,
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

export function singleBlockRewriteRequests(tab, block, span) {
  // Content-only rewrite of one block inside its existing paragraph. `span` is
  // the block's current named-range span [start, end) (newline included).
  // Keeps paragraph-level style and bullets; replaces text and inline styles.
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
  // Recreate the named range with exact bounds (insertion at a range boundary
  // doesn't reliably extend it).
  requests.push({ deleteNamedRange: { name: RANGE_PREFIX + block.id, tabsCriteria: { tabIds: [tabId] } } });
  requests.push({ createNamedRange: {
    name: RANGE_PREFIX + block.id,
    range: { startIndex: start, endIndex: start + plan.text.length + 1, tabId },
  } });
  return requests;
}

// --- Docs tab -> blocks -----------------------------------------------------------

function runToHtml(run) {
  const ts = run.textStyle || {};
  let html = escapeHtml(run.content.replace(/\n$/, "")).replace(/\u000b/g, "<br>");
  if (!html) return "";
  const isCode = (ts.weightedFontFamily?.fontFamily || "").includes("Courier");
  if (isCode) html = `<code>${html}</code>`;
  if (ts.strikethrough) html = `<s>${html}</s>`;
  if (ts.underline && !ts.link) html = `<u>${html}</u>`;
  if (ts.italic) html = `<em>${html}</em>`;
  if (ts.bold) html = `<strong>${html}</strong>`;
  if (ts.link?.url) html = `<a href="${escapeHtml(ts.link.url)}">${html}</a>`;
  return html;
}

export function parseLanguageTab(tab) {
  // Returns {blocks: [{id|null, type, attrs, html}], spans: Map(id -> [s,e))}
  const documentTab = tab.documentTab;
  const lists = documentTab.lists || {};

  // Named ranges: babel:<id> -> covered spans (may fragment after edits).
  const rangesById = new Map();
  for (const [name, group] of Object.entries(documentTab.namedRanges || {})) {
    if (!name.startsWith(RANGE_PREFIX)) continue;
    const id = name.slice(RANGE_PREFIX.length);
    for (const nr of group.namedRanges || []) {
      for (const r of nr.ranges || []) {
        if (!rangesById.has(id)) rangesById.set(id, []);
        rangesById.get(id).push([r.startIndex ?? 0, r.endIndex]);
      }
    }
  }
  const idAt = (index) => {
    for (const [id, spans] of rangesById) {
      for (const [s, e] of spans) if (index >= s && index < e) return id;
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
    let html = runs.map(runToHtml).join("");

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
      html = escapeHtml(plain.replace(/\u000b/g, "\n"));
    } else if ((ps.indentStart?.magnitude || 0) >= 18) {
      type = "blockquote";
    }

    let id = idAt(el.startIndex);
    if (id && usedIds.has(id)) id = null; // fragmented range: keep first claim
    if (id) {
      usedIds.add(id);
      spans.set(id, [el.startIndex, el.endIndex]);
    }
    blocks.push({ id, type, attrs, html });
  }
  // Drop a single trailing unregistered empty paragraph (Docs' mandatory final
  // newline shows up as one when the last block's named range got clipped).
  const last = blocks[blocks.length - 1];
  if (blocks.length && !last.id && !last.html) blocks.pop();
  return { blocks, spans };
}

export function assignIds(blocks) {
  for (const b of blocks) if (!b.id) b.id = newId();
  return blocks;
}
