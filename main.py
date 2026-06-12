"""
Babbel Docs - Collaborative multi-document editor with real-time translation.

Documents are lists of blocks. Each block has a stable id, a type
(paragraph/heading/list_item/blockquote/code), and per-language inline-HTML
content. Edits arrive over WebSocket as the full block list in the editor's
language; blocks are merged by id, changed blocks are retranslated to the
document's other languages with Claude.
"""
import os
import re
import json
import difflib
import asyncio
import logging
import secrets
import time
from html.parser import HTMLParser
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
import anthropic

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler("babbel.log"), logging.StreamHandler()],
)
logger = logging.getLogger("babbel")
for noisy in ("httpx", "httpcore", "watchfiles", "fontTools", "weasyprint"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

DOCS_DIR = Path("docs")
DOCS_DIR.mkdir(exist_ok=True)

TRANSLATION_MODEL = os.environ.get("TRANSLATION_MODEL", "claude-sonnet-4-6")
TRANSLATION_DEBOUNCE = 1.0  # seconds after the last edit before translating a block

# USD per million tokens (input, output), for the cost counter.
PRICING_PER_MTOK = {
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def add_usage(doc: dict, input_tokens: int, output_tokens: int, calls: int):
    usage = doc.setdefault("usage", {"input_tokens": 0, "output_tokens": 0,
                                     "calls": 0, "cost_usd": 0.0})
    pin, pout = PRICING_PER_MTOK.get(TRANSLATION_MODEL, (5.0, 25.0))
    usage["input_tokens"] += input_tokens
    usage["output_tokens"] += output_tokens
    usage["calls"] += calls
    usage["cost_usd"] += (input_tokens * pin + output_tokens * pout) / 1e6

# Common languages offered in the UI; any {code, name} pair is accepted.
LANGUAGE_CATALOG = {
    "en": "English", "pl": "Polish", "zh": "Mandarin Chinese", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "uk": "Ukrainian",
    "nl": "Dutch", "cs": "Czech", "sv": "Swedish", "ar": "Arabic",
    "hi": "Hindi", "tr": "Turkish", "vi": "Vietnamese", "el": "Greek",
}
DEFAULT_LANGUAGES = [
    {"code": "en", "name": "English"},
    {"code": "pl", "name": "Polish"},
    {"code": "zh", "name": "Mandarin Chinese"},
]

BLOCK_TYPES = {"paragraph", "heading", "list_item", "blockquote", "code"}

app = FastAPI()
anthropic_client = anthropic.AsyncAnthropic()


# --- Inline HTML sanitizer -------------------------------------------------
# Block content is author-supplied inline HTML that gets re-broadcast to every
# client and embedded in PDFs, so it must be restricted to formatting tags.

ALLOWED_TAGS = {"strong", "em", "u", "s", "code", "br", "a"}


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.open_tags = []

    def handle_starttag(self, tag, attrs):
        if tag not in ALLOWED_TAGS:
            return
        if tag == "br":
            self.out.append("<br>")
            return
        if tag == "a":
            href = next((v for k, v in attrs if k == "href"), "") or ""
            if not re.match(r"^https?://", href):
                href = ""
            self.out.append(f'<a href="{escape_html(href)}">')
        else:
            self.out.append(f"<{tag}>")
        self.open_tags.append(tag)

    def handle_endtag(self, tag):
        if tag in ALLOWED_TAGS and tag != "br" and tag in self.open_tags:
            self.open_tags.remove(tag)
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        self.out.append(escape_html(data))


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def sanitize_inline_html(html: str) -> str:
    parser = _Sanitizer()
    parser.feed(html or "")
    parser.close()
    for tag in reversed(parser.open_tags):
        parser.out.append(f"</{tag}>")
    return "".join(parser.out)


def strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", "", html or "")


# --- Sentence segmentation ---------------------------------------------------
# Blocks are translated sentence-by-sentence: when a paragraph is edited, only
# the changed sentences are sent to the model (with the paragraph as context).

ASCII_ENDERS = ".!?"
CJK_ENDERS = "。！？"  # 。！？


def split_sentences_html(html: str) -> list[str]:
    """Split inline HTML into sentence segments.

    Splits only at tag-balanced positions (a <strong> spanning two sentences
    keeps them in one segment) and keeps end punctuation plus trailing spaces
    attached to the preceding sentence, so segments concatenate losslessly.
    ASCII enders must be followed by whitespace or end-of-text (so "3.14" and
    "e.com/x.y" don't split); CJK enders split unconditionally.
    """
    parts, depth, start, i, n = [], 0, 0, 0, len(html)
    while i < n:
        c = html[i]
        if c == "<":
            close = html.find(">", i)
            if close == -1:
                break
            name = html[i + 1:close].strip("/ ").split()[0].lower() if close > i + 1 else ""
            if html[i + 1] == "/":
                depth -= 1
            elif name != "br" and not html[i + 1:close].endswith("/"):
                depth += 1
            i = close + 1
            continue
        if depth == 0 and c in ASCII_ENDERS + CJK_ENDERS:
            j = i + 1
            while j < n and html[j] in ASCII_ENDERS + CJK_ENDERS:
                j += 1
            cjk = any(ch in CJK_ENDERS for ch in html[i:j])
            if cjk or j >= n or html[j].isspace():
                while j < n and html[j] in " \xa0\t":
                    j += 1
                parts.append(html[start:j])
                start = i = j
                continue
        i += 1
    if start < n:
        parts.append(html[start:])
    return [p for p in parts if p]


def plan_sentence_updates(old_src_html: str | None, new_src_html: str,
                          existing_tgt_html: str | None) -> list[tuple[str, str]] | None:
    """Plan a sentence-level update of a translated block.

    Returns ops ("keep", target_sentence) / ("translate", source_sentence) in
    output order, or None when the existing translation can't be aligned with
    the old source (different sentence counts, no history) — in which case the
    whole block is translated sentence by sentence.
    """
    if not old_src_html or not existing_tgt_html:
        return None
    old_sents = split_sentences_html(old_src_html)
    tgt_sents = split_sentences_html(existing_tgt_html)
    if len(old_sents) != len(tgt_sents):
        return None
    new_sents = split_sentences_html(new_src_html)
    ops = []
    matcher = difflib.SequenceMatcher(a=old_sents, b=new_sents, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            ops.extend(("keep", t) for t in tgt_sents[i1:i2])
        elif tag != "delete":
            ops.extend(("translate", s) for s in new_sents[j1:j2])
    return ops


# --- Document store ---------------------------------------------------------

class DocStore:
    """In-memory documents, write-through to docs/<id>.json."""

    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.lock = asyncio.Lock()
        for path in DOCS_DIR.glob("*.json"):
            try:
                doc = json.loads(path.read_text())
                if isinstance(doc, dict) and "id" in doc:
                    self.docs[doc["id"]] = doc
            except (json.JSONDecodeError, OSError):
                logger.warning(f"Skipping unreadable doc file {path}")

    def save(self, doc: dict):
        doc["updated_at"] = time.time()
        path = DOCS_DIR / f"{doc['id']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False))
        tmp.replace(path)

    def create(self, title: str) -> dict:
        doc = {
            "id": secrets.token_hex(4),
            "title": title or "Untitled",
            "languages": [dict(l) for l in DEFAULT_LANGUAGES],
            "blocks": [],
            "updated_at": time.time(),
        }
        self.docs[doc["id"]] = doc
        self.save(doc)
        return doc

    def get(self, doc_id: str) -> dict:
        doc = self.docs.get(doc_id)
        if not doc:
            raise HTTPException(404, "Document not found")
        return doc

    def delete(self, doc_id: str):
        self.get(doc_id)
        del self.docs[doc_id]
        (DOCS_DIR / f"{doc_id}.json").unlink(missing_ok=True)


store = DocStore()


def merge_blocks(doc: dict, incoming: list, lang: str) -> list[str]:
    """Merge an edited block list (in `lang`) into the document.

    Blocks are matched by id. An incoming block without an "html" key is one
    the client didn't touch (it may be displaying fallback text from another
    language), so its content is kept as-is. Blocks with changed html become
    the new source text and are marked pending for the other languages.
    Returns ids of blocks that need translation.
    """
    old_by_id = {b["id"]: b for b in doc["blocks"]}
    other_langs = [l["code"] for l in doc["languages"] if l["code"] != lang]
    new_blocks, dirty = [], []
    seen = set()

    for raw in incoming:
        block_id = str(raw.get("id") or secrets.token_hex(4))
        if block_id in seen:
            block_id = secrets.token_hex(4)
        seen.add(block_id)
        btype = raw.get("type") if raw.get("type") in BLOCK_TYPES else "paragraph"
        attrs = raw.get("attrs") if isinstance(raw.get("attrs"), dict) else {}
        old = old_by_id.get(block_id)

        if "html" not in raw and old:
            new_blocks.append({**old, "type": btype, "attrs": attrs})
            continue
        html = sanitize_inline_html(raw.get("html", ""))
        if old and old.get("content", {}).get(lang) == html:
            new_blocks.append({**old, "type": btype, "attrs": attrs})
            continue

        content = dict(old.get("content", {})) if old else {}
        content[lang] = html
        block = {"id": block_id, "type": btype, "attrs": attrs,
                 "content": content, "source": lang}
        # Remember the source text the existing translations correspond to, so
        # the translator can diff sentences and retranslate only what changed.
        prev_html = None
        if old:
            if old.get("pending"):
                prev_html = old.get("prev_html")  # mid-edit: keep the original
            elif old.get("source") == lang:
                prev_html = old.get("content", {}).get(lang)
        if prev_html:
            block["prev_html"] = prev_html
        if btype == "code" or not strip_tags(html).strip():
            # Code and empty blocks are identical in every language.
            for code in other_langs:
                content[code] = html
            block["pending"] = []
        else:
            block["pending"] = list(other_langs)
            dirty.append(block_id)
        new_blocks.append(block)

    doc["blocks"] = new_blocks
    return dirty


def render_blocks(doc: dict, lang: str) -> list[dict]:
    """Project the document into one language for a client.

    Untranslated blocks fall back to their source language's text and are
    flagged pending so the UI can highlight them.
    """
    out = []
    for b in doc["blocks"]:
        html = b["content"].get(lang)
        pending = lang in b.get("pending", []) or html is None
        if html is None:
            html = b["content"].get(b.get("source", ""), "") or next(iter(b["content"].values()), "")
        out.append({"id": b["id"], "type": b["type"], "attrs": b.get("attrs", {}),
                    "html": html, "pending": pending})
    return out


# --- Translation ------------------------------------------------------------

class TranslationManager:
    """Debounced per-block translation tasks, keyed by (doc_id, block_id)."""

    def __init__(self):
        self.tasks: dict[tuple[str, str], asyncio.Task] = {}

    def schedule(self, doc_id: str, block_id: str):
        key = (doc_id, block_id)
        if key in self.tasks and not self.tasks[key].done():
            self.tasks[key].cancel()
        self.tasks[key] = asyncio.create_task(self._run(doc_id, block_id))
        self.tasks[key].add_done_callback(lambda t, k=key: self.tasks.pop(k, None))

    async def _run(self, doc_id: str, block_id: str):
        try:
            await asyncio.sleep(TRANSLATION_DEBOUNCE)
            doc = store.docs.get(doc_id)
            block = next((b for b in doc["blocks"] if b["id"] == block_id), None) if doc else None
            if not block or not block.get("pending"):
                return
            source = block["source"]
            source_html = block["content"][source]
            prev_html = block.get("prev_html")
            targets = list(block["pending"])
            lang_names = {l["code"]: l["name"] for l in doc["languages"]}
            context = self._context(doc, block_id, source)
            spent = {"input": 0, "output": 0, "calls": 0}

            results = await asyncio.gather(
                *(self._translate_block(source_html, prev_html, block["content"].get(t),
                                        lang_names[source], lang_names[t], context, spent)
                  for t in targets),
                return_exceptions=True,
            )

            # Record cost even if the result ends up discarded below.
            doc = store.docs.get(doc_id)
            if not doc:
                return
            add_usage(doc, spent["input"], spent["output"], spent["calls"])

            # Re-check state: the block may have been edited or deleted meanwhile.
            block = next((b for b in doc["blocks"] if b["id"] == block_id), None)
            if not block or block["content"].get(source) != source_html:
                store.save(doc)
                await rooms.broadcast_usage(doc)
                return
            errors = []
            for target, result in zip(targets, results):
                if isinstance(result, Exception):
                    errors.append(f"{lang_names.get(target, target)}: {result}")
                else:
                    block["content"][target] = sanitize_inline_html(result)
                    if target in block.get("pending", []):
                        block["pending"].remove(target)
            if not block.get("pending"):
                block.pop("prev_html", None)
            store.save(doc)
            await rooms.broadcast_doc(doc)
            await rooms.broadcast_usage(doc)
            if errors:
                logger.error(f"Translation errors for block {block_id}: {errors}")
                await rooms.broadcast_json(doc_id, {
                    "type": "error",
                    "message": "Some translations failed and will retry on the next edit.",
                })
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception(f"Translation task failed for {doc_id}/{block_id}")

    def _context(self, doc: dict, block_id: str, lang: str) -> dict:
        texts = [(b["id"], strip_tags(b["content"].get(lang, ""))) for b in doc["blocks"]]
        idx = next(i for i, (bid, _) in enumerate(texts) if bid == block_id)
        before = " ".join(t for _, t in texts[max(0, idx - 2):idx] if t)
        after = " ".join(t for _, t in texts[idx + 1:idx + 3] if t)
        return {"before": before, "after": after}

    async def _translate_block(self, source_html: str, prev_html: str | None,
                               existing: str | None, source_name: str,
                               target_name: str, context: dict, spent: dict) -> str:
        """Translate a block sentence by sentence, reusing unchanged sentences.

        When the existing translation aligns with the previous source text,
        only the edited sentences are sent to the model; the rest of the
        paragraph rides along as context.
        """
        ops = plan_sentence_updates(prev_html, source_html, existing)
        if ops is None:
            ops = [("translate", s) for s in split_sentences_html(source_html)]

        todo = [s for op, s in ops if op == "translate"]
        total = len(split_sentences_html(source_html))
        if not todo:
            return "".join(s for _, s in ops)
        logger.info(f"Translating {len(todo)}/{total} sentences to {target_name}")

        translated = await asyncio.gather(
            *(self._translate_sentence(s, source_html, existing, source_name,
                                       target_name, context, spent) for s in todo))
        results = iter(translated)
        parts = []
        for op, s in ops:
            if op == "keep":
                parts.append(s)
            else:
                trailing_ws = re.search(r"\s*$", s).group()
                parts.append(next(results) + trailing_ws)
        return "".join(parts)

    async def _translate_sentence(self, sentence: str, source_paragraph: str,
                                  target_paragraph: str | None, source_name: str,
                                  target_name: str, context: dict, spent: dict) -> str:
        prompt = f"""Translate ONE SENTENCE from {source_name} to {target_name}.

The sentence is inline HTML from a rich-text document. Preserve the HTML tags
(<strong>, <em>, <u>, <s>, <code>, <a>, <br>) around the corresponding words in
the translation; translate only the text. Keep equivalent end punctuation.

Document context before the paragraph: {context['before'] or '(start of document)'}
Full paragraph ({source_name}): {strip_tags(source_paragraph)}
Document context after the paragraph: {context['after'] or '(end of document)'}
{f'Current paragraph translation ({target_name}), the sentence must fit into it: {target_paragraph}' if target_paragraph else ''}

SENTENCE TO TRANSLATE: {sentence}

Reply with ONLY the translated sentence as inline HTML — no quotes, no explanation."""
        response = await anthropic_client.messages.create(
            model=TRANSLATION_MODEL,
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        spent["input"] += response.usage.input_tokens
        spent["output"] += response.usage.output_tokens
        spent["calls"] += 1
        if response.stop_reason == "refusal":
            raise RuntimeError("translation request was refused")
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        logger.info(f"Translated to {target_name}: '{strip_tags(text)[:48]}'")
        return text


translations = TranslationManager()


# --- WebSocket rooms ---------------------------------------------------------

class Rooms:
    """Connected clients per document; each client views one language."""

    def __init__(self):
        self.clients: dict[str, dict[WebSocket, str]] = {}

    def join(self, doc_id: str, ws: WebSocket, lang: str):
        self.clients.setdefault(doc_id, {})[ws] = lang

    def leave(self, doc_id: str, ws: WebSocket):
        room = self.clients.get(doc_id, {})
        room.pop(ws, None)
        if not room:
            self.clients.pop(doc_id, None)

    def presence(self, doc_id: str) -> dict:
        counts = {}
        for lang in self.clients.get(doc_id, {}).values():
            counts[lang] = counts.get(lang, 0) + 1
        return counts

    async def _send(self, doc_id: str, ws: WebSocket, message: dict):
        try:
            await ws.send_json(message)
        except Exception:
            self.leave(doc_id, ws)

    async def broadcast_json(self, doc_id: str, message: dict, exclude: WebSocket = None):
        for ws in list(self.clients.get(doc_id, {})):
            if ws is not exclude:
                await self._send(doc_id, ws, message)

    async def broadcast_doc(self, doc: dict, exclude: WebSocket = None):
        for ws, lang in list(self.clients.get(doc["id"], {}).items()):
            if ws is not exclude:
                await self._send(doc["id"], ws, {"type": "doc", "blocks": render_blocks(doc, lang)})

    async def broadcast_presence(self, doc_id: str):
        await self.broadcast_json(doc_id, {"type": "presence", "users": self.presence(doc_id)})

    async def broadcast_meta(self, doc: dict):
        await self.broadcast_json(doc["id"], {
            "type": "meta", "title": doc["title"], "languages": doc["languages"],
        })

    async def broadcast_usage(self, doc: dict):
        if doc.get("usage"):
            await self.broadcast_json(doc["id"], {"type": "usage", "usage": doc["usage"]})


rooms = Rooms()


@app.websocket("/ws/{doc_id}")
async def websocket_endpoint(ws: WebSocket, doc_id: str):
    if doc_id not in store.docs:
        await ws.close(code=4004)
        return
    await ws.accept()
    lang = ws.query_params.get("lang", "en")
    rooms.join(doc_id, ws, lang)
    try:
        doc = store.docs[doc_id]
        await ws.send_json({
            "type": "init", "title": doc["title"], "languages": doc["languages"],
            "blocks": render_blocks(doc, lang), "usage": doc.get("usage"),
        })
        await rooms.broadcast_presence(doc_id)

        while True:
            data = json.loads(await ws.receive_text())
            doc = store.docs.get(doc_id)
            if not doc:
                break
            msg_type = data.get("type")

            if msg_type == "lang":
                lang = str(data.get("lang", "en"))
                rooms.join(doc_id, ws, lang)
                await ws.send_json({"type": "doc", "blocks": render_blocks(doc, lang)})
                await rooms.broadcast_presence(doc_id)

            elif msg_type == "update":
                if lang not in [l["code"] for l in doc["languages"]]:
                    continue
                async with store.lock:
                    dirty = merge_blocks(doc, data.get("blocks", []), lang)
                    store.save(doc)
                await rooms.broadcast_doc(doc, exclude=ws)
                # Reply to the sender too: it needs pending flags, and any remote
                # changes it skipped while it had unsent edits.
                await ws.send_json({"type": "doc", "blocks": render_blocks(doc, lang)})
                for block_id in dirty:
                    translations.schedule(doc_id, block_id)

            elif msg_type == "sync":
                await ws.send_json({"type": "doc", "blocks": render_blocks(doc, lang)})

            elif msg_type == "title":
                doc["title"] = str(data.get("title", ""))[:200] or "Untitled"
                store.save(doc)
                await rooms.broadcast_meta(doc)

    except WebSocketDisconnect:
        pass
    finally:
        rooms.leave(doc_id, ws)
        await rooms.broadcast_presence(doc_id)


# --- REST API -----------------------------------------------------------------

@app.get("/api/docs")
async def list_docs():
    return sorted(
        ({"id": d["id"], "title": d["title"], "updated_at": d["updated_at"],
          "languages": d["languages"]} for d in store.docs.values()),
        key=lambda d: -d["updated_at"],
    )


@app.post("/api/docs")
async def create_doc(body: dict):
    return store.create(str(body.get("title", "")).strip()[:200])


@app.patch("/api/docs/{doc_id}")
async def update_doc(doc_id: str, body: dict):
    doc = store.get(doc_id)
    if "title" in body:
        doc["title"] = str(body["title"]).strip()[:200] or "Untitled"
    store.save(doc)
    await rooms.broadcast_meta(doc)
    return doc


@app.delete("/api/docs/{doc_id}")
async def delete_doc(doc_id: str):
    store.delete(doc_id)
    await rooms.broadcast_json(doc_id, {"type": "deleted"})
    return {"ok": True}


@app.post("/api/docs/{doc_id}/languages")
async def add_language(doc_id: str, body: dict):
    doc = store.get(doc_id)
    code = str(body.get("code", "")).strip().lower()[:8]
    name = str(body.get("name", "")).strip()[:64] or LANGUAGE_CATALOG.get(code, "")
    if not re.match(r"^[a-z][a-z0-9-]*$", code) or not name:
        raise HTTPException(400, "Need a language code and name")
    if any(l["code"] == code for l in doc["languages"]):
        raise HTTPException(409, "Language already added")
    doc["languages"].append({"code": code, "name": name})
    # Existing blocks need translating into the new language.
    for block in doc["blocks"]:
        if block["type"] == "code" or not strip_tags(block["content"].get(block["source"], "")).strip():
            block["content"][code] = block["content"].get(block["source"], "")
        elif code not in block["content"]:
            block.setdefault("pending", []).append(code)
            translations.schedule(doc_id, block["id"])
    store.save(doc)
    await rooms.broadcast_meta(doc)
    await rooms.broadcast_doc(doc)
    return doc["languages"]


@app.get("/api/languages")
async def language_catalog():
    return [{"code": c, "name": n} for c, n in LANGUAGE_CATALOG.items()]


# --- PDF export ----------------------------------------------------------------

PDF_CSS = """
@page { size: A4; margin: 2.2cm; @bottom-center { content: counter(page); font-size: 9pt; color: #888; } }
body { font-family: 'DejaVu Sans', 'Noto Sans CJK SC', sans-serif; font-size: 11pt; line-height: 1.55; color: #1a1a1a; }
h1.doc-title { font-size: 22pt; margin: 0 0 1.2em; border-bottom: 1.5pt solid #333; padding-bottom: 0.3em; }
h1 { font-size: 17pt; margin: 1em 0 0.4em; }
h2 { font-size: 14pt; margin: 1em 0 0.4em; }
h3 { font-size: 12pt; margin: 1em 0 0.4em; }
p { margin: 0 0 0.6em; }
ul, ol { margin: 0 0 0.6em; padding-left: 1.6em; }
blockquote { margin: 0 0 0.6em; padding: 0.1em 0 0.1em 1em; border-left: 3pt solid #bbb; color: #444; }
pre { background: #f4f4f4; border: 0.5pt solid #ddd; padding: 0.6em; font-family: 'DejaVu Sans Mono', monospace; font-size: 9.5pt; white-space: pre-wrap; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 0.9em; background: #f4f4f4; }
a { color: #0645ad; }
"""


def blocks_to_html(doc: dict, lang: str) -> str:
    parts = [f'<h1 class="doc-title">{escape_html(doc["title"])}</h1>']
    open_list = None
    for b in render_blocks(doc, lang):
        if b["type"] == "list_item":
            tag = "ol" if b["attrs"].get("list") == "ordered" else "ul"
            if open_list != tag:
                if open_list:
                    parts.append(f"</{open_list}>")
                parts.append(f"<{tag}>")
                open_list = tag
            parts.append(f"<li>{b['html']}</li>")
            continue
        if open_list:
            parts.append(f"</{open_list}>")
            open_list = None
        if b["type"] == "heading":
            level = min(max(int(b["attrs"].get("level", 1)), 1), 3)
            parts.append(f"<h{level}>{b['html']}</h{level}>")
        elif b["type"] == "blockquote":
            parts.append(f"<blockquote>{b['html']}</blockquote>")
        elif b["type"] == "code":
            parts.append(f"<pre>{b['html']}</pre>")
        else:
            parts.append(f"<p>{b['html'] or '&nbsp;'}</p>")
    if open_list:
        parts.append(f"</{open_list}>")
    return f"<html><head><meta charset='utf-8'><style>{PDF_CSS}</style></head><body>{''.join(parts)}</body></html>"


@app.get("/api/docs/{doc_id}/export.pdf")
async def export_pdf(doc_id: str, lang: str = "en"):
    doc = store.get(doc_id)
    html = blocks_to_html(doc, lang)

    def render() -> bytes:
        from weasyprint import HTML
        return HTML(string=html).write_pdf()

    pdf = await asyncio.get_event_loop().run_in_executor(None, render)
    filename = re.sub(r"[^\w\- ]", "", doc["title"])[:60] or "document"
    return Response(pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{filename}-{lang}.pdf"',
    })


# --- Static -------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def revalidate_static(request, call_next):
    # Force revalidation so clients pick up new frontend code after upgrades.
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
async def root():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    logger.info(f"Starting server on 0.0.0.0:8000 (model: {TRANSLATION_MODEL})")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True,
                reload_excludes=["*.log", "docs/*"])
