// Babbel Docs core logic, ported from the old server (main.py):
// inline-HTML sanitizer, sentence segmentation, sentence-level diff planning,
// and block merging. Pure functions, no I/O.

export const BLOCK_TYPES = new Set(["paragraph", "heading", "list_item", "blockquote", "code"]);

export const LANGUAGE_CATALOG = [
  ["en", "English"], ["pl", "Polish"], ["zh", "Mandarin Chinese"], ["es", "Spanish"],
  ["fr", "French"], ["de", "German"], ["ja", "Japanese"], ["ko", "Korean"],
  ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["nl", "Dutch"], ["cs", "Czech"], ["sv", "Swedish"], ["ar", "Arabic"],
  ["hi", "Hindi"], ["tr", "Turkish"], ["vi", "Vietnamese"], ["el", "Greek"],
].map(([code, name]) => ({ code, name }));

export const newId = () =>
  crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(16).padStart(8, "0"), "");

export const escapeHtml = (t) =>
  String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const stripTags = (html) => String(html || "").replace(/<[^>]+>/g, "");

// --- Inline HTML sanitizer ---------------------------------------------------
// Block content is author- or model-supplied inline HTML that gets rendered in
// every client, so it must be restricted to formatting tags.

const ALLOWED_TAGS = new Set(["strong", "em", "u", "s", "code", "br", "a"]);

export function sanitizeInlineHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(escapeHtml(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        const mapped = tag === "b" ? "strong" : tag === "i" ? "em" : tag === "del" ? "s" : tag;
        if (mapped === "br") {
          out.push("<br>");
        } else if (ALLOWED_TAGS.has(mapped)) {
          if (mapped === "a") {
            let href = child.getAttribute("href") || "";
            if (!/^https?:\/\//.test(href)) href = "";
            out.push(`<a href="${escapeHtml(href)}">`);
            walk(child);
            out.push("</a>");
          } else {
            out.push(`<${mapped}>`);
            walk(child);
            out.push(`</${mapped}>`);
          }
        } else {
          walk(child); // drop the tag, keep its content
        }
      }
    }
  };
  walk(div);
  return out.join("");
}

// --- Sentence segmentation -----------------------------------------------------
// Blocks are translated sentence-by-sentence: when a paragraph is edited, only
// the changed sentences are sent to the model (with the paragraph as context).

const ASCII_ENDERS = ".!?";
const CJK_ENDERS = "。！？"; // 。！？

export function splitSentencesHtml(html) {
  // Splits only at tag-balanced positions (a <strong> spanning two sentences
  // keeps them in one segment) and keeps end punctuation plus trailing spaces
  // attached to the preceding sentence, so segments concatenate losslessly.
  // ASCII enders must be followed by whitespace or end-of-text (so "3.14" and
  // "e.com/x.y" don't split); CJK enders split unconditionally.
  const parts = [];
  let depth = 0, start = 0, i = 0;
  const n = html.length;
  const enders = ASCII_ENDERS + CJK_ENDERS;
  while (i < n) {
    const c = html[i];
    if (c === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) break;
      const inner = html.slice(i + 1, close);
      const name = inner.replace(/^[/ ]+/, "").split(/[\s/]/)[0].toLowerCase();
      if (html[i + 1] === "/") depth -= 1;
      else if (name !== "br" && !inner.endsWith("/")) depth += 1;
      i = close + 1;
      continue;
    }
    if (depth === 0 && enders.includes(c)) {
      let j = i + 1;
      while (j < n && enders.includes(html[j])) j += 1;
      const cjk = [...html.slice(i, j)].some((ch) => CJK_ENDERS.includes(ch));
      if (cjk || j >= n || /\s/.test(html[j])) {
        while (j < n && "  \t".includes(html[j])) j += 1;
        parts.push(html.slice(start, j));
        start = i = j;
        continue;
      }
    }
    i += 1;
  }
  if (start < n) parts.push(html.slice(start));
  return parts.filter((p) => p);
}

// --- Sequence diff (difflib-style opcodes over string arrays) -------------------

export function diffOpcodes(a, b) {
  // LCS dynamic program; returns [tag, i1, i2, j1, j2] opcodes like difflib.
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  const push = (tag, i1, i2, j1, j2) => {
    const last = ops[ops.length - 1];
    if (last && last[0] === tag && last[2] === i1 && last[4] === j1) { last[2] = i2; last[4] = j2; }
    else ops.push([tag, i1, i2, j1, j2]);
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("equal", i, i + 1, j, j + 1); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push("delete", i, i + 1, j, j); i++; }
    else { push("insert", i, i, j, j + 1); j++; }
  }
  if (i < n) push("delete", i, n, j, j);
  if (j < m) push("insert", n, n, j, m);
  // Merge adjacent delete+insert into replace, like difflib does.
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && ((last[0] === "delete" && op[0] === "insert") || (last[0] === "insert" && op[0] === "delete"))) {
      merged[merged.length - 1] = ["replace", Math.min(last[1], op[1]), Math.max(last[2], op[2]),
        Math.min(last[3], op[3]), Math.max(last[4], op[4])];
      continue;
    }
    merged.push(op);
  }
  return merged;
}

export function computeSentenceMerge(oldSents, newSents) {
  // Assign sentence ids to an edited sentence list by diffing against the
  // previous one. oldSents: [{sid, html}]; newSents: [{pid, html}].
  // Equal sentences (ignoring surrounding whitespace — separators shuffle
  // when paragraphs split/merge) keep their id; edited ones reuse the id they
  // replace pairwise (so a sentence being typed in keeps a stable id);
  // surplus new ones get fresh ids; missing ones are removed. sepOnly marks
  // a whitespace-only change (write it, but don't retranslate).
  const norm = (h) => String(h ?? "").trim();
  const a = oldSents.map((s) => norm(s.html));
  const b = newSents.map((s) => norm(s.html));
  const out = newSents.map((s) => ({ ...s, sid: null, changed: false, sepOnly: false }));
  const removed = [];
  for (const [tag, i1, i2, j1, j2] of diffOpcodes(a, b)) {
    if (tag === "equal") {
      for (let k = 0; k < j2 - j1; k++) {
        const o = oldSents[i1 + k];
        out[j1 + k].sid = o.sid;
        if (o.html !== newSents[j1 + k].html) out[j1 + k].sepOnly = true;
      }
    } else if (tag === "replace") {
      const len = j2 - j1;
      for (let k = 0; k < len; k++) {
        out[j1 + k].changed = true;
        out[j1 + k].sid = i1 + k < i2 ? oldSents[i1 + k].sid : newId();
      }
      for (let i = i1 + len; i < i2; i++) removed.push(oldSents[i].sid);
    } else if (tag === "insert") {
      for (let j = j1; j < j2; j++) { out[j].sid = newId(); out[j].changed = true; }
    } else {
      for (let i = i1; i < i2; i++) removed.push(oldSents[i].sid);
    }
  }
  return { sents: out, removed };
}

export function mergeSidSequences(seqs) {
  // Merge per-language sentence-id sequences of one paragraph into one
  // canonical order: shared ids anchor the alignment, ids unique to either
  // side are interleaved after their predecessors. First sequence leads.
  let acc = seqs[0] ? [...seqs[0]] : [];
  for (let i = 1; i < seqs.length; i++) {
    const b = seqs[i];
    const merged = [];
    for (const [tag, i1, i2, j1, j2] of diffOpcodes(acc, b)) {
      if (tag !== "insert") merged.push(...acc.slice(i1, i2));
      if (tag === "insert" || tag === "replace") merged.push(...b.slice(j1, j2));
    }
    const seen = new Set();
    acc = merged.filter((x) => !seen.has(x) && seen.add(x));
  }
  return acc;
}

export function diffSentenceIndices(prevHtml, newHtml) {
  // Which sentences does an edit touch? Returns {n, d, ins} or null (no
  // history => treat as whole-block):
  //   n   - indices into the NEW source sentences being translated
  //         (outgoing highlight in source-language views)
  //   d   - indices into the OLD sentences being replaced/removed
  //         (incoming highlight in target-language views, which still show
  //         the old, aligned translation)
  //   ins - old-sentence positions where NEW sentences are inserted
  //         (blank-space placeholder in target-language views)
  if (!prevHtml) return null;
  const oldS = splitSentencesHtml(prevHtml);
  const newS = splitSentencesHtml(newHtml || "");
  const n = [], d = [], ins = [];
  for (const [tag, i1, i2, j1, j2] of diffOpcodes(oldS, newS)) {
    if (tag === "equal") continue;
    for (let j = j1; j < j2; j++) n.push(j);
    if (tag === "insert") ins.push(i1);
    else for (let i = i1; i < i2; i++) d.push(i);
  }
  return { n, d, ins };
}

export function sentencePlainOffsets(html) {
  // Plain-text [start, end) offset of each sentence, matching ProseMirror's
  // text positions (entities decoded, <br> counts as one position).
  const out = [];
  let pos = 0;
  const div = document.createElement("div");
  for (const s of splitSentencesHtml(html || "")) {
    div.innerHTML = s;
    const len = div.textContent.length + div.querySelectorAll("br").length;
    out.push([pos, pos + len]);
    pos += len;
  }
  return out;
}

export function planSentenceUpdates(oldSrcHtml, newSrcHtml, existingTgtHtml) {
  // Plan a sentence-level update of a translated block. Returns ops
  // ["keep", targetSentence] / ["translate", sourceSentence] in output order,
  // or null when the existing translation can't be aligned with the old source
  // (different sentence counts, no history) — in which case the whole block is
  // translated sentence by sentence.
  if (!oldSrcHtml || !existingTgtHtml) return null;
  const oldSents = splitSentencesHtml(oldSrcHtml);
  const tgtSents = splitSentencesHtml(existingTgtHtml);
  if (oldSents.length !== tgtSents.length) return null;
  const newSents = splitSentencesHtml(newSrcHtml);
  const ops = [];
  for (const [tag, i1, i2, j1, j2] of diffOpcodes(oldSents, newSents)) {
    if (tag === "equal") for (const t of tgtSents.slice(i1, i2)) ops.push(["keep", t]);
    else if (tag !== "delete") for (const s of newSents.slice(j1, j2)) ops.push(["translate", s]);
  }
  return ops;
}

// --- Block merging ---------------------------------------------------------------

export function mergeBlocks(model, incoming, lang) {
  // Merge an edited block list (in `lang`) into the document model.
  //
  // Blocks are matched by id. An incoming block without an "html" key is one
  // the client didn't touch (it may be displaying fallback text from another
  // language), so its content is kept as-is. Blocks with changed html become
  // the new source text and are marked pending for the other languages.
  // Mutates model.blocks; returns ids of blocks that need translation.
  const oldById = new Map(model.blocks.map((b) => [b.id, b]));
  const otherLangs = model.languages.map((l) => l.code).filter((c) => c !== lang);
  const newBlocks = [], dirty = [];
  const seen = new Set();

  for (const raw of incoming) {
    let blockId = String(raw.id || newId());
    if (seen.has(blockId)) blockId = newId();
    seen.add(blockId);
    const btype = BLOCK_TYPES.has(raw.type) ? raw.type : "paragraph";
    const attrs = raw.attrs && typeof raw.attrs === "object" ? raw.attrs : {};
    const old = oldById.get(blockId);

    if (!("html" in raw) && old) {
      newBlocks.push({ ...old, type: btype, attrs });
      continue;
    }
    const html = sanitizeInlineHtml(raw.html || "");
    if (old && old.content[lang] === html) {
      newBlocks.push({ ...old, type: btype, attrs });
      continue;
    }

    const content = old ? { ...old.content } : {};
    content[lang] = html;
    const block = { id: blockId, type: btype, attrs, content, source: lang };
    // Remember the source text the existing translations correspond to, so the
    // translator can diff sentences and retranslate only what changed.
    let prevHtml = null;
    if (old) {
      if (old.pending && old.pending.length) prevHtml = old.prev_html; // mid-edit: keep the original
      else if (old.source === lang) prevHtml = old.content[lang];
    }
    if (prevHtml) block.prev_html = prevHtml;
    if (btype === "code" || !stripTags(html).trim()) {
      // Code and empty blocks are identical in every language.
      for (const code of otherLangs) content[code] = html;
      block.pending = [];
    } else {
      block.pending = [...otherLangs];
      dirty.push(blockId);
    }
    newBlocks.push(block);
  }

  model.blocks = newBlocks;
  return dirty;
}

export function renderBlocks(model, lang) {
  // Project the document model into one language for the editor. Untranslated
  // blocks fall back to their source language's text and are flagged pending
  // so the UI can highlight them.
  return model.blocks.map((b) => {
    let html = b.content[lang];
    const pending = (b.pending || []).includes(lang) || html == null;
    if (html == null) {
      html = b.content[b.source] ?? Object.values(b.content)[0] ?? "";
    }
    return { id: b.id, type: b.type, attrs: b.attrs || {}, html, pending };
  });
}

export function blockContext(model, blockId, lang) {
  // Two blocks of plain text before/after the block, as translation context.
  const texts = model.blocks.map((b) => [b.id, stripTags(b.content[lang] || "")]);
  const idx = texts.findIndex(([bid]) => bid === blockId);
  const before = texts.slice(Math.max(0, idx - 2), idx).map(([, t]) => t).filter(Boolean).join(" ");
  const after = texts.slice(idx + 1, idx + 3).map(([, t]) => t).filter(Boolean).join(" ");
  return { before, after };
}
