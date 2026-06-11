# Babbel Docs - Agent Notes

## Quick Start
```bash
source venv/bin/activate && python main.py
# Open http://localhost:8000
pytest tests/ -q
```

## Files
- `main.py` - Backend: REST (docs/languages/PDF export), per-document WebSocket
  rooms, block merge, debounced per-block translation (AsyncAnthropic).
- `static/app.js` - Frontend: ProseMirror editor, sidebar, toolbar, WS sync.
- `static/vendor/prosemirror.js` - Committed ESM bundle (rebuild with esbuild
  from prosemirror-* packages if upgrading; no runtime CDN dependency).
- `docs/*.json` - One JSON file per document (gitignored).
- `tests/test_main.py` - Unit tests for sanitizer/merge/render/PDF html.

## Architecture
A document is a flat list of blocks `{id, type, attrs, content: {lang: html},
source, pending}`. Clients send their language's block list over WS; blocks
without an "html" key are untouched (they may be displaying fallback text from
another language - never treat that as content). Merging is by block id, so
unchanged and reordered blocks keep their translations. Changed blocks become
the new source and are retranslated to the document's other languages
(per-block debounce, cancel-on-reedit, keyed by block id).

## Invariants to keep
- Block ids are stable across edits, type toggles, and list wrap/lift
  (frontend idPlugin adopts paragraph ids into list items and back).
- Inline HTML is sanitized server-side (`ALLOWED_TAGS`) - everything sent to
  clients or the PDF renderer has passed `sanitize_inline_html`.
- Code blocks and empty blocks are copied verbatim to all languages, never
  translated.

## Style
Short, elegant, functional. Minimize files. Readability > extensibility.
