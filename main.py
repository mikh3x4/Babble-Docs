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
    parts = []
    for item in doc:
        if isinstance(item, dict):
            parts.append(item.get(lang, ""))
        else:
            parts.append(item)
    return "".join(parts)

def text_to_doc(text: str, lang: str, existing_doc: list = None) -> list:
    if not text:
        return []

    pattern = f'([{re.escape(SENTENCE_ENDERS)}]+\\s*|\\n+)'
    parts = re.split(pattern, text)

    new_doc = []
    content_idx = 0

    for part in parts:
        if not part:
            continue

        is_sep = bool(re.match(f'^[{re.escape(SENTENCE_ENDERS)}\\s\\n]+$', part))

        if is_sep:
            new_doc.append(part)
        else:
            content_dict = {lang: part}
            if existing_doc:
                existing_contents = [item for item in existing_doc if isinstance(item, dict)]
                if content_idx < len(existing_contents):
                    for other_lang in LANGUAGES:
                        if other_lang != lang and other_lang in existing_contents[content_idx]:
                            content_dict[other_lang] = existing_contents[content_idx][other_lang]
            new_doc.append(content_dict)
            content_idx += 1

    return new_doc

def get_content_blocks(doc: list) -> list[dict]:
    return [item for item in doc if isinstance(item, dict)]

# --- Translation ---

def translate_block(block: str, prev_block: str, next_block: str,
                    prev_target: str, next_target: str,
                    existing_translation: str,
                    source_lang: str, target_lang: str) -> str:
    logger.info(f"Translating: {source_lang} -> {target_lang}")

    client = anthropic.Anthropic()

    existing_hint = ""
    if existing_translation and not existing_translation.startswith("["):
        existing_hint = f"\nPrevious translation (for consistency, may need updating): {existing_translation}"

    prompt = f"""Translate from {LANGUAGES[source_lang]} to {LANGUAGES[target_lang]}.

Context (source language):
Previous: {prev_block or '(start)'}
TRANSLATE THIS: {block}
Next: {next_block or '(end)'}

Target language context:
Previous: {prev_target or '(start)'}
Next: {next_target or '(end)'}
{existing_hint}

Return ONLY the translated sentence. No quotes, no explanation."""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    return response.content[0].text.strip()

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

        # Notify ONLY other-language clients that translation is starting
        # Same-language clients already have the text, they don't need the highlight
        logger.info(f"Starting translation, notifying non-{source_lang} clients")
        for ws, ws_lang in list(clients.items()):
            if ws_lang != source_lang:  # Only other languages
                try:
                    await ws.send_json({"type": "translating", "blocks": changed_indices})
                    logger.info(f"Sent translating to {ws_lang} client")
                except:
                    clients.pop(ws, None)

        # Load current doc state
        doc = load_doc()
        contents = get_content_blocks(doc)

        for idx in changed_indices:
            if translation_cancelled:
                logger.info("Translation cancelled mid-process")
                break

            if idx >= len(contents):
                continue

            source_text = contents[idx].get(source_lang, "")
            if not source_text:
                continue

            prev_source = contents[idx-1].get(source_lang, "") if idx > 0 else ""
            next_source = contents[idx+1].get(source_lang, "") if idx < len(contents)-1 else ""

            for target_lang in LANGUAGES:
                if target_lang == source_lang:
                    continue

                if translation_cancelled:
                    break

                existing = contents[idx].get(target_lang, "")
                prev_target = contents[idx-1].get(target_lang, "") if idx > 0 else ""
                next_target = contents[idx+1].get(target_lang, "") if idx < len(contents)-1 else ""

                # Run translation in thread pool to not block
                logger.info(f"Translating block {idx}: {source_lang}->{target_lang}")
                translated = await asyncio.get_event_loop().run_in_executor(
                    None,
                    translate_block,
                    source_text, prev_source, next_source,
                    prev_target, next_target, existing,
                    source_lang, target_lang
                )

                if translation_cancelled:
                    logger.info("Translation cancelled mid-block")
                    break

                logger.info(f"Block {idx} {target_lang}: '{source_text[:30]}...' -> '{translated[:30]}...'")
                contents[idx][target_lang] = translated

        if not translation_cancelled:
            logger.info(f"Translation complete, saving and broadcasting")
            save_doc(doc)
            await send_doc_to_all(doc, exclude=exclude_ws)

        # Clear translating state for other-language clients
        for ws, ws_lang in list(clients.items()):
            if ws_lang != source_lang:
                try:
                    await ws.send_json({"type": "translating", "blocks": []})
                except:
                    clients.pop(ws, None)
        logger.info(f"Cleared translating state for non-{source_lang} clients")

    except asyncio.CancelledError:
        logger.info("Translation task cancelled")
        # Clear for all non-source-lang clients (source_lang might not be in scope if cancelled early)
        for ws in list(clients.keys()):
            try:
                await ws.send_json({"type": "translating", "blocks": []})
            except:
                clients.pop(ws, None)
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

                # Find what changed
                changed_indices = []
                for i in range(max(len(old_contents), len(new_contents))):
                    old_text = old_contents[i].get(source_lang, "") if i < len(old_contents) else ""
                    new_text_i = new_contents[i].get(source_lang, "") if i < len(new_contents) else ""
                    if old_text != new_text_i:
                        changed_indices.append(i)
                        logger.info(f"Block {i} changed: '{old_text[:20]}' -> '{new_text_i[:20]}'")

                # Save immediately
                save_doc(new_doc)

                # Broadcast to same-language clients immediately
                logger.info(f"Broadcasting to other {source_lang} clients")
                await broadcast_to_lang(source_lang, {
                    "type": "doc",
                    "text": doc_to_text(new_doc, source_lang)
                }, exclude=ws)

                if not changed_indices:
                    # Only separators changed
                    logger.info("Only separators changed, broadcasting to all")
                    await send_doc_to_all(new_doc, exclude=ws)
                    continue

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
