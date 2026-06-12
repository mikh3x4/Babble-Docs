# Babbel Docs

A collaborative rich-text editor with real-time translation. Multiple users can
edit the same document in different languages; edited blocks are automatically
retranslated into the document's other languages with Claude.

## Features

- **Rich text**: bold/italic/underline/strikethrough, headings, bullet and
  numbered lists, blockquotes, code blocks, links (ProseMirror editor).
- **Multiple documents**: sidebar to create, rename, switch, and delete docs.
- **Per-document languages**: starts with English/Polish/Mandarin; add any
  language from the catalog (or a custom code/name) per document.
- **Real-time sync**: WebSockets; blocks being translated are highlighted.
- **PDF export**: server-rendered PDF of the language you're viewing
  (WeasyPrint; CJK supported via Noto fonts).

## Setup

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# WeasyPrint needs Pango (usually present); Chinese PDF output needs CJK fonts:
sudo apt-get install fonts-noto-cjk

cp .env.example .env   # add your Anthropic API key
```

Optional env vars: `TRANSLATION_MODEL` (default `claude-sonnet-4-6`).

## Run

```bash
python main.py
```

Open http://localhost:8000. Open multiple tabs with different languages to see
real-time translation.

## How it works

A document is a flat list of blocks (`paragraph | heading | list_item |
blockquote | code`), each with a stable id and per-language inline-HTML
content. Clients send the block list in their editing language; the server
merges by block id, so unchanged blocks keep their translations. Changed
blocks become the new source text and are retranslated (debounced, per block,
cancel-on-reedit) into the document's other languages by Claude. Code blocks
and empty blocks are shared verbatim across languages. Until a translation
arrives, other-language clients see the source text highlighted.

## Files

- `main.py` — FastAPI backend: REST (docs/languages/PDF), per-document
  WebSocket rooms, block merge, translation pipeline.
- `static/app.js` — frontend: ProseMirror editor, sidebar, toolbar, WS sync.
- `static/index.html`, `static/style.css` — shell and styles.
- `static/vendor/prosemirror.js` — committed ProseMirror bundle (rebuild with
  esbuild if upgrading; no runtime CDN dependency).
- `docs/` — document storage, one JSON file per document.
- `tests/` — `pytest tests/ -v`.

## Conflict model

Last write wins at block granularity. Edits to *different* blocks from
different languages merge cleanly; concurrent edits to the same block resolve
to the most recent write, which becomes that block's source language.
