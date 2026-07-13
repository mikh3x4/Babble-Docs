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

## Architecture (storage v2)
The Google Doc is the database, without duplicated content. One tab per
language = the only store of text (one block per paragraph). Named ranges
`babel:<id>:<ownHash>:<srcHash>` carry block identity + sync state: ownHash =
hash of the block's content in that tab at last app write (actual != own =>
external edit => reconcile/repair); srcHash = hash of the source content a
translation was made from (src != source tab's actual hash => stale =>
pending); own == src marks the source language. Hashes are FNV-1a over a
canonical form (docmodel `blockHash`/`canonicalInline`) so Docs run-splitting
and tag ordering never look like edits. `babel:meta` tab = config only
(languages incl. tabId, apiKey, model, usage). The in-memory model
(`deriveModel` in app.js) is rebuilt from the tabs on every pull; pending is
derived, never stored. prev_html for sentence-diffing is in-memory only
(`prevHtmlById`) — a dead client costs one whole-block retranslation.
Translation locks are Drive `appProperties` (`lock_<blockId>` =
`clientId:ts[:n..;d..;i..]`, 2 min TTL, invisible, per-key patches) read on
the 500ms metadata poll; the optional spec carries sentence indices
(diffSentenceIndices) so other clients highlight only affected sentences:
yellow `.pending` = incoming replacement, blue `.outgoing` = source text
being translated out, `.incoming-gap` widget = blank space where inserted
text will appear. Blocks stay paragraph-granular in storage; sentence
granularity applies to translation, locking display, and highlights.
When an edit changes a block's source language, the old source tab's
own==src claim is revoked in the same atomic batch (and deriveModel
tie-breaks dual claims by which tab the other srcHashes point at). Writes are serialized through `writeChain`, conditioned on
`writeControl.requiredRevisionId`, rebuilt+retried on conflict, and end with
a snapshot refetch.

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
