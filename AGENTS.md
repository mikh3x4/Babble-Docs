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

## Architecture
The Google Doc is the database. `babel:meta` tab = canonical model JSON
(languages incl. tabId, apiKey, usage, blocks `{id, type, attrs,
content: {lang: html}, source, pending, prev_html}`). One tab per language =
rendered view (one block per paragraph; named range `babel:<id>` carries the
block id, spanning the paragraph incl. its trailing newline). Clients poll the
Drive file `version` every 500ms and refetch the doc on change. Edits (from
this app or typed directly in Google Docs) are merged by block id
(`mergeBlocks`); changed blocks become the new source and are retranslated
sentence-by-sentence. Translation mutual exclusion uses `[babel-lock]` Drive
comments (2 min TTL); human comments are never touched. All writes are
serialized through `writeChain` and always end with a snapshot refetch so
indices are never computed against a stale doc.

## Invariants to keep
- Block ids are stable across edits, type toggles, and list wrap/lift
  (idPlugin adopts paragraph ids into list items and back).
- Everything rendered or written passed `sanitizeInlineHtml`.
- Code blocks and empty blocks are copied verbatim to all languages, never
  translated.
- Multi-request batchUpdates must account for index shifts: bullets are
  created last and bottom-up (they consume leading tabs); single-block
  rewrites are applied bottom-up.
- Only touch comments whose content starts with `[babel-lock]`.

## Testing
Pure logic and the Docs conversion layer have node tests (jsdom for the DOM
bits) - see the scratchpad pattern: copy modules to .mjs, stub
document/Node, run. OAuth/end-to-end needs a real browser + authorized origin.

## Style
Short, elegant, functional. Minimize files. Readability > extensibility.
