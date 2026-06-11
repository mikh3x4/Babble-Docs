"""
Babbel Docs - Collaborative Translation Editor
Single document with merged language representation.
"""
import re
import json
import logging
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import anthropic

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler('babbel.log'), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("watchfiles").setLevel(logging.WARNING)
load_dotenv()

app = FastAPI()
DOCS_DIR = Path("docs")
DOCS_DIR.mkdir(exist_ok=True)

SENTENCE_ENDERS = '.!?\u3002\uff01\uff1f'
LANGUAGES = {"en": "English", "pl": "Polish", "zh": "Mandarin Chinese"}
TRANSLATION_DELAY = 0.5  # seconds to wait before starting translation
PLACEHOLDER = '…'  # Used for completely empty blocks
FALLBACK_MARKER = '⟨'  # Prefix for fallback text (source language shown while translating)

clients: dict[WebSocket, str] = {}
DOC_PATH = DOCS_DIR / "document.json"

# Per-block translation task management
# Maps block content (source text) -> asyncio.Task for that block's translation
pending_translations: dict[str, asyncio.Task] = {}

def load_doc() -> list:
    if DOC_PATH.exists():
        try:
            return json.loads(DOC_PATH.read_text())
        except:
            pass
    return []

def save_doc(doc: list):
    DOC_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2))

def doc_to_text(doc: list, lang: str) -> str:
    """Convert doc to text for a specific language. Show source text for missing translations."""
    parts = []
    for item in doc:
        if isinstance(item, dict):
            text = item.get(lang, "")
            if not text:
                # Show source language text with marker (will be highlighted)
                for fallback_lang in LANGUAGES:
                    if fallback_lang in item and item[fallback_lang]:
                        text = FALLBACK_MARKER + item[fallback_lang]
                        break
                if not text:
                    text = PLACEHOLDER
            parts.append(text)
        else:
            parts.append(item)
    return "".join(parts)

def text_to_doc(text: str, lang: str, existing_doc: list = None) -> list:
    """Parse text into doc structure, preserving translations by CONTENT matching."""
    if not text:
        return []

    # Remove placeholders and fallback markers from incoming text
    text = text.replace(PLACEHOLDER, '').replace(FALLBACK_MARKER, '')

    pattern = f'([{re.escape(SENTENCE_ENDERS)}]+\\s*|\\n+)'
    parts = [p for p in re.split(pattern, text) if p]

    def is_sep(p):
        return bool(re.match(f'^[{re.escape(SENTENCE_ENDERS)}\\s\\n]+$', p))

    # Build lookup: content -> old block (for content matching)
    old_contents = [item for item in existing_doc if isinstance(item, dict)] if existing_doc else []
    content_to_block = {}
    for block in old_contents:
        content = block.get(lang, "")
        if content and content not in content_to_block:
            content_to_block[content] = block

    new_doc = []
    used_contents = set()  # Track which old blocks we've used

    for part in parts:
        if is_sep(part):
            new_doc.append(part)
        else:
            content_dict = {lang: part}
            # Try to find exact content match in old blocks
            if part in content_to_block and part not in used_contents:
                old_block = content_to_block[part]
                used_contents.add(part)
                # Copy translations from matched block
                for other_lang in LANGUAGES:
                    if other_lang != lang and other_lang in old_block:
                        content_dict[other_lang] = old_block[other_lang]
            new_doc.append(content_dict)

    return new_doc

def get_content_blocks(doc: list) -> list[dict]:
    return [item for item in doc if isinstance(item, dict)]

# --- Translation ---

def remove_sentence_enders(text: str) -> str:
    """Remove ALL sentence-ending punctuation from translation to preserve document structure."""
    # Remove all sentence enders (ASCII + Unicode variants) and newlines
    for char in SENTENCE_ENDERS + '。！？．｡\n\r':
        text = text.replace(char, '')
    return text.strip()

def translate_block(block: str, context_before: str, context_after: str,
                    target_context_before: str, target_context_after: str,
                    existing_translation: str,
                    source_lang: str, target_lang: str) -> str:
    """
    Translate a single block. Context may include multiple preceding/following blocks
    for short segments that need more context (like "e" from "e.g.").
    """
    logger.info(f"Translating: {source_lang} -> {target_lang}: '{block[:30]}'")

    client = anthropic.Anthropic()

    existing_hint = ""
    if existing_translation and not existing_translation.startswith("["):
        existing_hint = f"\nPrevious translation (may need updating): {existing_translation}"

    prompt = f"""Translate from {LANGUAGES[source_lang]} to {LANGUAGES[target_lang]}.

Context before: {context_before or '(start of document)'}
>>> TRANSLATE THIS: {block}
Context after: {context_after or '(end of document)'}

Target language context:
Before: {target_context_before or '(start)'}
After: {target_context_after or '(end)'}
{existing_hint}

IMPORTANT: Return ONLY the translation of "{block}". Do NOT include any punctuation like periods, exclamation marks, or question marks at the end - punctuation is handled separately. No quotes, no explanation."""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    result = response.content[0].text.strip()
    # Remove any sentence-ending punctuation the LLM might have added
    result = remove_sentence_enders(result)
    logger.info(f"Translation result: '{result[:50]}'")
    return result

# --- Broadcasting ---

async def broadcast(message: dict, exclude: WebSocket = None):
    sent_to = []
    for ws in list(clients.keys()):
        if ws != exclude:
            try:
                await ws.send_json(message)
                sent_to.append(clients.get(ws, "?"))
            except:
                clients.pop(ws, None)
    logger.info(f"Broadcast {message.get('type')}: sent to {len(sent_to)} clients {sent_to}")

async def broadcast_to_lang(lang: str, message: dict, exclude: WebSocket = None):
    sent_count = 0
    for ws, ws_lang in list(clients.items()):
        if ws_lang == lang and ws != exclude:
            try:
                await ws.send_json(message)
                sent_count += 1
            except:
                clients.pop(ws, None)
    logger.info(f"Broadcast to {lang}: sent {message.get('type')} to {sent_count} clients")

async def send_doc_to_all(doc: list, exclude: WebSocket = None):
    sent_to = []
    for ws, lang in list(clients.items()):
        if ws != exclude:
            try:
                await ws.send_json({
                    "type": "doc",
                    "text": doc_to_text(doc, lang)
                })
                sent_to.append(lang)
            except:
                clients.pop(ws, None)
    logger.info(f"Sent doc to {len(sent_to)} clients: {sent_to}")

# --- Delayed Translation ---

async def do_single_block_translation(block_content: str, block_idx: int, source_lang: str, exclude_ws: WebSocket):
    """Translate a single block after delay. Can be cancelled if block is edited again."""
    exclude_lang = clients.get(exclude_ws, "?")
    logger.info(f"Translation task started for block {block_idx}: '{block_content[:30]}' from {source_lang}")

    try:
        # Wait before starting translation
        logger.info(f"Waiting {TRANSLATION_DELAY}s before translating block {block_idx}")
        await asyncio.sleep(TRANSLATION_DELAY)

        # Load current doc state and find the block by content
        doc = load_doc()
        contents = get_content_blocks(doc)

        # Find the block by content (it may have moved)
        actual_idx = None
        for i, block in enumerate(contents):
            if block.get(source_lang) == block_content:
                actual_idx = i
                break

        if actual_idx is None:
            logger.info(f"Block '{block_content[:30]}' no longer exists, skipping translation")
            return

        def get_context(idx: int, lang: str, direction: int) -> str:
            """Get context in given direction (-1 for before, +1 for after)."""
            parts = []
            i = idx + direction
            while 0 <= i < len(contents) and len(parts) < 2:
                text = contents[i].get(lang, "")
                if direction < 0:
                    parts.insert(0, text)
                else:
                    parts.append(text)
                if len(text) >= 10 or len(parts) >= 2:
                    break
                i += direction
            return " ".join(parts) if parts else ""

        async def translate_to_lang(target_lang: str):
            """Translate block to a single target language."""
            context_before = get_context(actual_idx, source_lang, -1)
            context_after = get_context(actual_idx, source_lang, +1)
            target_before = get_context(actual_idx, target_lang, -1)
            target_after = get_context(actual_idx, target_lang, +1)
            existing = contents[actual_idx].get(target_lang, "")

            logger.info(f"Translating block {actual_idx}: {source_lang}->{target_lang}")
            translated = await asyncio.get_event_loop().run_in_executor(
                None,
                translate_block,
                block_content, context_before, context_after,
                target_before, target_after, existing,
                source_lang, target_lang
            )
            return (target_lang, translated)

        # Translate to all other languages in parallel
        tasks = [translate_to_lang(lang) for lang in LANGUAGES if lang != source_lang]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Re-load doc and find block again (may have changed during translation)
        doc = load_doc()
        contents = get_content_blocks(doc)
        actual_idx = None
        for i, block in enumerate(contents):
            if block.get(source_lang) == block_content:
                actual_idx = i
                break

        if actual_idx is None:
            logger.info(f"Block '{block_content[:30]}' removed during translation, discarding")
            return

        # Apply results
        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Translation error: {result}")
            elif result:
                target_lang, translated = result
                contents[actual_idx][target_lang] = translated

        logger.info(f"Block translation complete, saving doc")
        save_doc(doc)

        # Send updated doc to affected clients
        await send_doc_to_all(doc, exclude=exclude_ws)

        # Update translating highlights (remove this block from pending)
        await broadcast_translating_status(source_lang)

    except asyncio.CancelledError:
        logger.info(f"Translation cancelled for block '{block_content[:30]}'")
    except Exception as e:
        logger.error(f"Translation error for block: {e}")
    finally:
        # Clean up from pending_translations
        pending_translations.pop(block_content, None)

async def broadcast_translating_status(source_lang: str):
    """Broadcast current translating blocks to non-source-lang clients."""
    # Get all blocks currently being translated
    translating_contents = set(pending_translations.keys())

    # Find indices of these blocks in current doc
    doc = load_doc()
    contents = get_content_blocks(doc)
    translating_indices = []
    for i, block in enumerate(contents):
        for lang in LANGUAGES:
            if block.get(lang) in translating_contents:
                translating_indices.append(i)
                break

    for ws, ws_lang in list(clients.items()):
        if ws_lang != source_lang:
            try:
                await ws.send_json({"type": "translating", "blocks": translating_indices})
            except:
                clients.pop(ws, None)
    logger.info(f"Broadcast translating status: {translating_indices}")

# --- WebSocket Handler ---

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    clients[ws] = "en"
    logger.info(f"Client connected. Total: {len(clients)}")
    await broadcast({"type": "clients", "count": len(clients)})

    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type")

            if msg_type == "load":
                lang = data.get("lang", "en")
                clients[ws] = lang
                doc = load_doc()
                await ws.send_json({"type": "doc", "text": doc_to_text(doc, lang)})
                await broadcast({"type": "clients", "count": len(clients)})

            elif msg_type == "update":
                source_lang = data["lang"]
                new_text = data["text"]
                logger.info(f"Update from {source_lang} client: {len(new_text)} chars")

                old_doc = load_doc()
                new_doc = text_to_doc(new_text, source_lang, old_doc)

                new_contents = get_content_blocks(new_doc)
                logger.info(f"Blocks: {len(get_content_blocks(old_doc))} -> {len(new_contents)}")

                # Find blocks that need translation (missing any target language)
                blocks_needing_translation = []
                for i, block in enumerate(new_contents):
                    block_text = block.get(source_lang, "")
                    for lang in LANGUAGES:
                        if lang != source_lang and lang not in block:
                            blocks_needing_translation.append((i, block_text))
                            logger.info(f"Block {i} needs translation (missing {lang}): '{block_text[:30]}'")
                            break

                # Broadcast immediately, save async
                await send_doc_to_all(new_doc, exclude=ws)
                save_doc(new_doc)

                if not blocks_needing_translation:
                    logger.info("No content changes needing translation")
                    continue

                # For each block needing translation, check if we already have a pending task
                for idx, block_content in blocks_needing_translation:
                    if block_content in pending_translations:
                        # Same block edited again - cancel old task and start new one
                        old_task = pending_translations[block_content]
                        if not old_task.done():
                            old_task.cancel()
                            logger.info(f"Cancelled pending translation for block '{block_content[:30]}'")

                    # Start new translation task for this block
                    pending_translations[block_content] = asyncio.create_task(
                        do_single_block_translation(block_content, idx, source_lang, ws)
                    )
                    logger.info(f"Scheduled translation for block {idx}: '{block_content[:30]}'")

                # Broadcast translating status with all pending block indices
                await broadcast_translating_status(source_lang)

    except WebSocketDisconnect:
        clients.pop(ws, None)
        logger.info(f"Client disconnected. Total: {len(clients)}")
        await broadcast({"type": "clients", "count": len(clients)})

# --- Static Files ---

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting server on 0.0.0.0:8000")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True,
                reload_excludes=["*.log", "docs/*"])
