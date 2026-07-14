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
- `static/app.js` - UI shell: ProseMirror editor, blocks<->PM conversion,
  decoration plugin, views (landing/setup/editor), wiring to the engine.
- `static/sync.js` - The sync engine (createEngine): model derivation, poll
  loop, serialized revision-conditioned writes, appProperties locks,
  translation scheduling, Claude conflict merge, and buildMarks (the single
  source of highlight state). Knows nothing about ProseMirror.
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

## Architecture (paragraph blocks + hashed ranges)
The Google Doc is the database, without duplicated content. One tab per
language = the only store of text; one BLOCK = one Docs paragraph, tracked by
an invisible named range `babel:<id>:<ownHash>:<srcHash>` (own = hash of the
block's canonical content at last app write, actual!=own => external edit =>
reconcile; src = hash of the source content a translation was made from,
mismatch => stale => pending; own==src marks the source language, dual claims
tie-broken by srcHash votes). Hashes are FNV-1a over a canonical inline form
so Docs run-splitting/tag order never look like edits. `babel:meta` tab =
config only. The model (deriveModel) is rebuilt from the tabs on every pull.
Translation is sentence-diffed WITHIN a block (planSentenceUpdates; prev_html
in-memory only), locked via invisible appProperties `lock_<blockId>` taken at
edit time; the lock value carries sentence indices so other clients highlight
only affected sentences. Writes are serialized, conditioned on
writeControl.requiredRevisionId, retried 5x with backoff. CONFLICTS: before
writing, resolveConflicts compares the tab's current text against editBase
(what the local edit started from) — a genuine simultaneous edit of the same
paragraph in the same language is three-way merged by Claude
(T.mergeParagraphs) with a purple highlight, then retranslated. Highlights:
green .editing = your held edit (fires ~1s after typing pauses), blue
.outgoing = being translated out, yellow .pending = incoming replacement,
purple .merged = simultaneous edits just merged, .incoming-gap = insert
placeholder. Long paragraphs (>900 chars) get a one-time warning toast —
paragraphs are the sync/merge unit. Polling: Drive metadata every 500ms
(locks ride along); Docs revisionId probed every tick while active, every 2s
idle.

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
