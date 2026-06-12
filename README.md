# Babbel Docs

A collaborative rich-text editor with real-time translation. Everyone edits
the same document in their own language; edited sentences are automatically
retranslated into the document's other languages with Claude.

| English view | Same document in Chinese |
|---|---|
| ![Editor, English](screenshots/editor-en.png) | ![Editor, Chinese](screenshots/editor-zh.png) |

## Features

- **Rich text** (ProseMirror): bold / italic / underline / strikethrough,
  inline code, links, H1–H3, nested bullet & numbered lists, blockquotes,
  code blocks. Markdown shortcuts while typing (`# `, `- `, `> `, ``` ``` ```).
- **Sentence-level translation**: only the sentences you actually edited are
  retranslated — the surrounding paragraph, its current translation, and the
  neighboring blocks ride along as context. Formatting survives translation.
- **Multiple documents**: sidebar to create, rename, switch, delete.
- **Per-document languages**: starts with English / Polish / Mandarin; add any
  language (catalog or custom) and existing content is translated into it.
- **Markdown in & out**: "Copy MD" puts the whole document on the clipboard as
  Markdown; "Paste MD" inserts clipboard Markdown at the cursor.
- **PDF export** of whichever language you're viewing (WeasyPrint, CJK-ready).
- **Cost counter**: live per-document Claude spend in the top bar (hover for
  calls / token counts).
- **Real-time presence** and yellow highlights on blocks awaiting translation.

## Run

```bash
./run.sh
```

That creates the venv, installs dependencies, scaffolds `.env` (add your
`ANTHROPIC_API_KEY`), and starts the server on http://localhost:8000.
Open multiple tabs with different languages to see live translation.

For Chinese PDF output install CJK fonts once: `sudo apt-get install fonts-noto-cjk`.

Optional env vars: `TRANSLATION_MODEL` (default `claude-sonnet-4-6`).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+B / Ctrl+I / Ctrl+U | Bold / italic / underline |
| Tab / Shift+Tab (in a list) | Indent / outdent list item |
| Ctrl+] / Ctrl+[ | Same, where Tab is awkward |
| Enter (in a list) | New list item |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| `# `, `## `, `- `, `1. `, `> `, ``` ``` ``` | Heading / list / quote / code block as you type |

## How it works

A document is a flat list of blocks (`paragraph | heading | list_item |
blockquote | code`), each with a stable id and per-language inline-HTML
content. Clients send their language's block list over a WebSocket; the server
merges by block id, so unchanged, reordered, restyled, or re-indented blocks
keep their translations. For an edited block the server diffs its sentences
against the source text the existing translations were made from: unchanged
sentences keep their translation, edited ones are retranslated (debounced,
cancel-on-reedit). Code blocks and empty blocks are shared verbatim. Until a
translation arrives, other-language readers see the source text highlighted.

Conflicts resolve last-write-wins per block; the most recent writer's language
becomes that block's source language.

## Files

- `main.py` — FastAPI backend: REST (docs / languages / PDF), per-document
  WebSocket rooms, block merge, sentence-diff translation pipeline.
- `static/app.js` — frontend: ProseMirror editor, sidebar, toolbar, WS sync,
  markdown conversion.
- `static/vendor/prosemirror.js` — committed ProseMirror bundle (esbuild;
  no runtime CDN dependency).
- `docs/` — document storage, one JSON file per document (gitignored).
- `tests/` — `pytest tests/ -q`.
