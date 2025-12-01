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
TRANSLATION_DELAY = 2.0  # seconds to wait before starting translation
PLACEHOLDER = '…'  # Used for completely empty blocks
FALLBACK_MARKER = '⟨'  # Prefix for fallback text (source language shown while translating)

clients: dict[WebSocket, str] = {}
DOC_PATH = DOCS_DIR / "document.json"

# Translation task management
pending_translation_task: asyncio.Task | None = None
translation_cancelled = False

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

async def do_translation(source_lang: str, changed_indices: list, exclude_ws: WebSocket):
    """Perform translation after delay. Can be cancelled if new edits come in."""
    global translation_cancelled
    exclude_lang = clients.get(exclude_ws, "?")
    logger.info(f"Translation task started: blocks {changed_indices} from {source_lang} (exclude {exclude_lang} client)")

    try:
        # Wait before starting translation
        logger.info(f"Waiting {TRANSLATION_DELAY}s before translating blocks {changed_indices}")
        await asyncio.sleep(TRANSLATION_DELAY)

        if translation_cancelled:
            logger.info("Translation cancelled during delay")
            return

        # Highlight already sent immediately in websocket handler
        logger.info(f"Starting translation for blocks {changed_indices}")

        # Load current doc state
        doc = load_doc()
        contents = get_content_blocks(doc)

        def get_context(idx: int, lang: str, direction: int) -> str:
            """
            Get context in given direction (-1 for before, +1 for after).
            If adjacent block is short (<10 chars), include one more block for context.
            """
            parts = []
            i = idx + direction
            while 0 <= i < len(contents) and len(parts) < 2:
                text = contents[i].get(lang, "")
                if direction < 0:
                    parts.insert(0, text)
                else:
                    parts.append(text)
                # If this block is short, get one more for context
                if len(text) >= 10 or len(parts) >= 2:
                    break
                i += direction
            return " ".join(parts) if parts else ""

        # Build list of all translation tasks
        async def translate_one(idx: int, target_lang: str):
            """Translate a single block to a single language."""
            if idx >= len(contents):
                return None

            source_text = contents[idx].get(source_lang, "")
            if not source_text:
                return None

            # Get extended context if adjacent blocks are short
            context_before = get_context(idx, source_lang, -1)
            context_after = get_context(idx, source_lang, +1)
            target_before = get_context(idx, target_lang, -1)
            target_after = get_context(idx, target_lang, +1)
            existing = contents[idx].get(target_lang, "")

            logger.info(f"Translating block {idx}: {source_lang}->{target_lang} (context: '{context_before[:20]}' | '{context_after[:20]}')")
            translated = await asyncio.get_event_loop().run_in_executor(
                None,
                translate_block,
                source_text, context_before, context_after,
                target_before, target_after, existing,
                source_lang, target_lang
            )
            return (idx, target_lang, translated)

        # Create all translation tasks
        tasks = []
        for idx in changed_indices:
            for target_lang in LANGUAGES:
                if target_lang != source_lang:
                    tasks.append(translate_one(idx, target_lang))

        logger.info(f"Running {len(tasks)} translations in parallel")

        # Run all translations in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)

        if translation_cancelled:
            logger.info("Translation cancelled, discarding results")
        else:
            # Apply results
            for result in results:
                if isinstance(result, Exception):
                    logger.error(f"Translation error: {result}")
                elif result:
                    idx, target_lang, translated = result
                    contents[idx][target_lang] = translated

            logger.info(f"Translation complete, saving doc")
            save_doc(doc)

            # Clear translating state BEFORE sending doc update
            for ws, ws_lang in list(clients.items()):
                if ws_lang != source_lang:
                    try:
                        await ws.send_json({"type": "translating", "blocks": []})
                    except:
                        clients.pop(ws, None)
            logger.info(f"Cleared translating state for non-{source_lang} clients")

            # Now send the updated doc
            await send_doc_to_all(doc, exclude=exclude_ws)

    except asyncio.CancelledError:
        logger.info("Translation task cancelled")
        # Don't clear highlights - new task will send its own, or edit handler already did
    except Exception as e:
        logger.error(f"Translation error: {e}")
        for ws in list(clients.keys()):
            try:
                await ws.send_json({"type": "translating", "blocks": []})
            except:
                clients.pop(ws, None)

def cancel_pending_translation():
    """Cancel any pending translation task."""
    global pending_translation_task, translation_cancelled
    if pending_translation_task and not pending_translation_task.done():
        translation_cancelled = True
        pending_translation_task.cancel()
        logger.info("Cancelled pending translation")
    translation_cancelled = False

# --- WebSocket Handler ---

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    global pending_translation_task, translation_cancelled

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

                old_contents = get_content_blocks(old_doc)
                new_contents = get_content_blocks(new_doc)
                logger.info(f"Blocks: {len(old_contents)} -> {len(new_contents)}")

                # Find blocks that need translation (missing any target language)
                # Content matching in text_to_doc already preserved translations for unchanged blocks
                changed_indices = []
                for i, block in enumerate(new_contents):
                    block_text = block.get(source_lang, "")[:30]
                    for lang in LANGUAGES:
                        if lang != source_lang and lang not in block:
                            changed_indices.append(i)
                            logger.info(f"Block {i} needs translation (missing {lang}): '{block_text}'")
                            break

                # Broadcast immediately, save async
                await send_doc_to_all(new_doc, exclude=ws)
                save_doc(new_doc)  # TODO: make truly async if needed

                if not changed_indices:
                    logger.info("No content changes")
                    continue

                # Send translating highlight IMMEDIATELY (don't wait for 2s delay)
                for ws_client, ws_lang in list(clients.items()):
                    if ws_lang != source_lang:
                        try:
                            await ws_client.send_json({"type": "translating", "blocks": changed_indices})
                        except:
                            clients.pop(ws_client, None)
                logger.info(f"Sent immediate translating highlight for blocks: {changed_indices}")

                # Cancel any pending translation and start new one
                cancel_pending_translation()
                translation_cancelled = False

                logger.info(f"Scheduling translation for {len(changed_indices)} blocks: {changed_indices}")
                pending_translation_task = asyncio.create_task(
                    do_translation(source_lang, changed_indices, ws)
                )

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
