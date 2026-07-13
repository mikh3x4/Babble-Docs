# Babbel Docs - Agent Notes

## Quick Start
```bash
python3 -m http.server 8100   # then open http://localhost:8100
# (OAuth requires the origin to be authorized in the GCP client; localhost
# usually is. There is no backend and no build step.)
```

## Files
- `index.html` - The whole UI: landing (sign-in / open doc), first-time setup,
  and the editor view. Served from repo root for GitHub Pages.
- `static/app.js` - Main app: ProseMirror editor, poll/merge/write sync loop,
  translation scheduling, comment locks, language + cost UI.
- `static/core.js` - Pure logic: sanitizer, sentence split, LCS diff,
  `planSentenceUpdates`, `mergeBlocks`, `renderBlocks`.
- `static/docmodel.js` - Blocks <-> Google Docs conversion: `babel:meta` JSON
  tab, per-language tabs, named ranges `babel:<id>`, batchUpdate request
  builders (full-tab rewrite and single-block rewrite) and tab parser.
- `static/gdocs.js` - Google Identity Services auth + Docs/Drive fetch
  wrappers. `CLIENT_ID` lives here.
- `static/translate.js` - Anthropic Messages API from the browser
  (`anthropic-dangerous-direct-browser-access`), pricing table, sentence
  translation pipeline.
- `static/vendor/prosemirror.js` - Committed ESM bundle (rebuild with esbuild
  from prosemirror-* packages if upgrading; no runtime CDN dependency).

## Architecture (storage v3, two-tier)
The Google Doc is the database, without duplicated content. One tab per
language = the only store of text. PARAGRAPHS are the structural unit (one
Docs paragraph each; heading/list/indent attrs; identity via named range
`babelp:<pid>:<attrsHash>`). SENTENCES are the sync/merge/translation unit:
each sentence span carries `babel:<sid>:<ownHash>:<srcHash>` (own = hash at
last app write, actual!=own => external edit => reconcile; src = hash of the
source sentence a translation was made from, mismatch => stale => pending;
own==src marks the source language, dual claims tie-broken by srcHash votes).
Segmentation in translated tabs is DEFINED by the ranges; sentence heuristics
(core `splitSentencesHtml`) only run on the language being edited. Editing:
the editor stays paragraph-based; `sendUpdate` flat-diffs displayed vs editor
sentences (`computeSentenceMerge`: equal keeps sid even across paragraph
splits, edited reuses the replaced sid, inserts mint sids) into INTENTS,
applied to the model (`applyIntents`) and written as paragraph-content
rewrites in the edited tab only. Writes are serialized, conditioned on
`writeControl.requiredRevisionId`; on conflict the model is re-derived from
the fresh doc (`buildModel`) and the intents re-applied — this is what makes
two clients editing different sentences of the same paragraph merge. Sentence
order across tabs is anchor-merged (`mergeSidSequences`). Translation is per
sentence (paragraph both-language context in the prompt), locked via
invisible Drive appProperties `lock_<sid>` (2 min TTL) taken at edit time and
read on the 500ms metadata poll. Highlights: yellow `.pending` = incoming
replacement span, blue `.outgoing` = source span being translated,
`.incoming-gap` widget = untranslated insert. `babel:meta` tab = config only.

## Invariants to keep
- Block ids are stable across edits, type toggles, and list wrap/lift
  (idPlugin adopts paragraph ids into list items and back).
- Everything rendered or written passed `sanitizeInlineHtml`.
- Code blocks and empty blocks are copied verbatim to all languages, never
  translated.
- Multi-request batchUpdates must account for index shifts: bullets are
  created last and bottom-up (they consume leading tabs); single-block
  rewrites are applied bottom-up.
- Locks live in appProperties only; never write user-visible artifacts
  (comments) for coordination.

## Testing
Pure logic and the Docs conversion layer have node tests (jsdom for the DOM
bits) - see the scratchpad pattern: copy modules to .mjs, stub
document/Node, run. OAuth/end-to-end needs a real browser + authorized origin.

## Style
Short, elegant, functional. Minimize files. Readability > extensibility.
