"""
Babbel Docs - Collaborative Translation Editor
Single document with merged language representation.
"""
import re
import json
import logging
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import anthropic

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler('babbel.log'), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)
load_dotenv()

app = FastAPI()
DOCS_DIR = Path("docs")
DOCS_DIR.mkdir(exist_ok=True)

SENTENCE_ENDERS = '.!?\u3002\uff01\uff1f'
LANGUAGES = {"en": "English", "pl": "Polish", "zh": "Mandarin Chinese"}

clients: dict[WebSocket, str] = {}

DOC_PATH = DOCS_DIR / "document.json"

def load_doc() -> list:
    if DOC_PATH.exists():
        try:
            return json.loads(DOC_PATH.read_text())
        except:
            pass
    return []

def save_doc(doc: list):
    logger.debug(f"save_doc: {len(doc)} items")
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
    """Translate a content block with context and existing translation for consistency."""
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
    for ws in list(clients.keys()):
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                clients.pop(ws, None)

async def broadcast_to_lang(lang: str, message: dict, exclude: WebSocket = None):
    for ws, ws_lang in list(clients.items()):
        if ws_lang == lang and ws != exclude:
            try:
                await ws.send_json(message)
            except:
                clients.pop(ws, None)

async def send_doc_to_all(doc: list, exclude: WebSocket = None):
    for ws, lang in list(clients.items()):
        if ws != exclude:
            try:
                await ws.send_json({
                    "type": "doc",
                    "text": doc_to_text(doc, lang)
                })
            except:
                clients.pop(ws, None)

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
            logger.debug(f"Message: {msg_type}")

            if msg_type == "load":
                lang = data.get("lang", "en")
                clients[ws] = lang
                doc = load_doc()
                await ws.send_json({"type": "doc", "text": doc_to_text(doc, lang)})
                await broadcast({"type": "clients", "count": len(clients)})

            elif msg_type == "update":
                source_lang = data["lang"]
                new_text = data["text"]

                old_doc = load_doc()
                new_doc = text_to_doc(new_text, source_lang, old_doc)

                old_contents = get_content_blocks(old_doc)
                new_contents = get_content_blocks(new_doc)

                # Find what changed - only in SOURCE language
                changed_indices = []
                for i in range(max(len(old_contents), len(new_contents))):
                    old_text = old_contents[i].get(source_lang, "") if i < len(old_contents) else ""
                    new_text_i = new_contents[i].get(source_lang, "") if i < len(new_contents) else ""
                    if old_text != new_text_i:
                        changed_indices.append(i)

                # Save immediately
                save_doc(new_doc)

                # Broadcast to same-language clients
                await broadcast_to_lang(source_lang, {
                    "type": "doc",
                    "text": doc_to_text(new_doc, source_lang)
                }, exclude=ws)

                if not changed_indices:
                    # Only separators changed - broadcast to all
                    await send_doc_to_all(new_doc, exclude=ws)
                    continue

                # Content changed - need to translate
                logger.info(f"Changed blocks: {changed_indices}")
                await broadcast({"type": "syncing", "active": True})

                # Send pending (original text) to other languages
                for idx in changed_indices:
                    if idx < len(new_contents):
                        original_text = new_contents[idx].get(source_lang, "")
                        for target_lang in LANGUAGES:
                            if target_lang != source_lang:
                                new_contents[idx][target_lang] = f"[{original_text}]"

                save_doc(new_doc)
                await send_doc_to_all(new_doc, exclude=ws)

                # Now translate each changed block
                for idx in changed_indices:
                    if idx >= len(new_contents):
                        continue

                    source_text = new_contents[idx].get(source_lang, "")
                    if not source_text:
                        continue

                    prev_source = new_contents[idx-1].get(source_lang, "") if idx > 0 else ""
                    next_source = new_contents[idx+1].get(source_lang, "") if idx < len(new_contents)-1 else ""

                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue

                        # Get existing translation for consistency
                        existing = ""
                        if idx < len(old_contents) and target_lang in old_contents[idx]:
                            existing = old_contents[idx][target_lang]

                        prev_target = new_contents[idx-1].get(target_lang, "") if idx > 0 else ""
                        next_target = new_contents[idx+1].get(target_lang, "") if idx < len(new_contents)-1 else ""

                        translated = translate_block(
                            source_text, prev_source, next_source,
                            prev_target, next_target,
                            existing,
                            source_lang, target_lang
                        )
                        new_contents[idx][target_lang] = translated

                save_doc(new_doc)
                await send_doc_to_all(new_doc)
                await broadcast({"type": "syncing", "active": False})

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
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
