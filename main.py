"""
Babbel Docs - Collaborative Translation Editor
Simplified architecture with chunk-based document storage.
"""
import os
import re
import json
import asyncio
import logging
import time
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

# Configurable sentence-ending characters
SENTENCE_ENDERS = '.!?\u3002\uff01\uff1f'  # ASCII + Chinese punctuation

LANGUAGES = {"en": "English", "pl": "Polish", "zh": "Mandarin Chinese"}
clients: dict[WebSocket, str] = {}

# --- Document as Chunks ---
# Document is stored as JSON: {"chunks": [{"type": "content"|"separator", "text": "..."}]}
# Alternates: content, separator, content, separator, ...
# Separators are: sentence-enders OR newlines

def get_doc_path(lang: str) -> Path:
    return DOCS_DIR / f"{lang}.json"

def text_to_chunks(text: str) -> list[dict]:
    """Convert plain text to chunks (alternating content/separator)."""
    if not text:
        return []

    chunks = []
    # Pattern: match either sentence-ender (with optional following whitespace) or newlines
    pattern = f'([{re.escape(SENTENCE_ENDERS)}]\\s*|\\n+)'
    parts = re.split(pattern, text)

    for i, part in enumerate(parts):
        if not part:
            continue
        # Check if this is a separator
        is_sep = bool(re.match(f'^[{re.escape(SENTENCE_ENDERS)}\\n\\s]+$', part))
        chunk_type = "separator" if is_sep else "content"

        # Merge consecutive same-type chunks
        if chunks and chunks[-1]["type"] == chunk_type:
            chunks[-1]["text"] += part
        else:
            chunks.append({"type": chunk_type, "text": part})

    return chunks

def chunks_to_text(chunks: list[dict]) -> str:
    """Convert chunks back to plain text."""
    return "".join(c["text"] for c in chunks)

def get_content_chunks(chunks: list[dict]) -> list[tuple[int, dict]]:
    """Get list of (index, chunk) for content chunks only."""
    return [(i, c) for i, c in enumerate(chunks) if c["type"] == "content"]

def read_doc(lang: str) -> list[dict]:
    """Read document as chunks."""
    path = get_doc_path(lang)
    if path.exists():
        try:
            data = json.loads(path.read_text())
            return data.get("chunks", [])
        except:
            pass
    return []

def write_doc(lang: str, chunks: list[dict]):
    """Write document as chunks."""
    logger.debug(f"write_doc({lang}): {len(chunks)} chunks")
    get_doc_path(lang).write_text(json.dumps({"chunks": chunks}, ensure_ascii=False))

def read_doc_text(lang: str) -> str:
    """Read document as plain text."""
    return chunks_to_text(read_doc(lang))

def write_doc_text(lang: str, text: str):
    """Write document from plain text."""
    write_doc(lang, text_to_chunks(text))

# --- Translation ---

def translate_block(block: str, prev_block: str, next_block: str,
                    prev_target: str, next_target: str,
                    source_lang: str, target_lang: str) -> str:
    """Translate a content block with context from both languages."""
    logger.info(f"Translating block from {source_lang} to {target_lang}")

    client = anthropic.Anthropic()
    prompt = f"""Translate a sentence from {LANGUAGES[source_lang]} to {LANGUAGES[target_lang]}.

Source language context:
Previous: {prev_block or '(none)'}
TRANSLATE THIS: {block}
Next: {next_block or '(none)'}

Target language context (for style/consistency):
Previous: {prev_target or '(none)'}
Next: {next_target or '(none)'}

Return ONLY the translated sentence. No quotes, no explanation."""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    result = response.content[0].text.strip()
    logger.debug(f"Translation result: {result[:100]}")
    return result

# --- Broadcasting ---

async def broadcast(message: dict, exclude: WebSocket = None):
    """Send to all clients."""
    for ws in list(clients.keys()):
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                clients.pop(ws, None)

async def broadcast_to_lang(lang: str, message: dict, exclude: WebSocket = None):
    """Send to clients viewing specific language."""
    for ws, ws_lang in list(clients.items()):
        if ws_lang == lang and ws != exclude:
            try:
                await ws.send_json(message)
            except:
                clients.pop(ws, None)

# --- WebSocket Handler ---

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    clients[ws] = "en"
    logger.info(f"Client connected. Total: {len(clients)}")

    # Send connection count
    await broadcast({"type": "clients", "count": len(clients)})

    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type")
            logger.debug(f"Message: {msg_type}")

            if msg_type == "load":
                lang = data.get("language", "en")
                clients[ws] = lang
                text = read_doc_text(lang)
                await ws.send_json({"type": "doc", "lang": lang, "text": text})
                await broadcast({"type": "clients", "count": len(clients)})

            elif msg_type == "update":
                # Client sent full document text
                source_lang = data["lang"]
                new_text = data["text"]
                old_chunks = read_doc(source_lang)
                new_chunks = text_to_chunks(new_text)

                # Save source immediately
                write_doc(source_lang, new_chunks)

                # Broadcast to same-language clients
                await broadcast_to_lang(source_lang, {
                    "type": "doc", "lang": source_lang, "text": new_text
                }, exclude=ws)

                # Find which content block changed
                old_contents = get_content_chunks(old_chunks)
                new_contents = get_content_chunks(new_chunks)

                # Simple diff: find first different content block
                changed_idx = None
                change_type = None  # 'edit', 'insert', 'delete'

                if len(new_contents) > len(old_contents):
                    change_type = 'insert'
                    for i in range(len(old_contents)):
                        if old_contents[i][1]["text"] != new_contents[i][1]["text"]:
                            changed_idx = i
                            break
                    if changed_idx is None:
                        changed_idx = len(old_contents)
                elif len(new_contents) < len(old_contents):
                    change_type = 'delete'
                    for i in range(len(new_contents)):
                        if old_contents[i][1]["text"] != new_contents[i][1]["text"]:
                            changed_idx = i
                            break
                    if changed_idx is None:
                        changed_idx = len(new_contents)
                else:
                    change_type = 'edit'
                    for i in range(len(new_contents)):
                        if old_contents[i][1]["text"] != new_contents[i][1]["text"]:
                            changed_idx = i
                            break

                if changed_idx is None:
                    # No content change (only separator change)
                    # Propagate separator changes to all languages
                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue
                        # Just update separators, keep content
                        target_chunks = read_doc(target_lang)
                        # Copy separator pattern from source
                        write_doc(target_lang, target_chunks)
                        await broadcast_to_lang(target_lang, {
                            "type": "doc", "lang": target_lang,
                            "text": chunks_to_text(target_chunks)
                        })
                    continue

                # Content changed - need to translate
                logger.info(f"Content change: {change_type} at index {changed_idx}")

                # Get context from source
                prev_block = new_contents[changed_idx-1][1]["text"] if changed_idx > 0 else ""
                next_block = new_contents[changed_idx+1][1]["text"] if changed_idx < len(new_contents)-1 else ""
                changed_block = new_contents[changed_idx][1]["text"] if change_type != 'delete' else ""

                # Notify other languages: show syncing
                await broadcast({"type": "syncing", "active": True})

                # Send pending (original text in red) to other languages
                for target_lang in LANGUAGES:
                    if target_lang != source_lang and change_type != 'delete':
                        await broadcast_to_lang(target_lang, {
                            "type": "pending",
                            "index": changed_idx,
                            "text": changed_block,
                            "source_lang": source_lang
                        })

                # Translate to each target language
                for target_lang in LANGUAGES:
                    if target_lang == source_lang:
                        continue

                    target_chunks = read_doc(target_lang)
                    target_contents = get_content_chunks(target_chunks)

                    # Get target context
                    prev_target = target_contents[changed_idx-1][1]["text"] if changed_idx > 0 and changed_idx-1 < len(target_contents) else ""
                    next_target = target_contents[changed_idx+1][1]["text"] if changed_idx+1 < len(target_contents) else ""

                    if change_type == 'delete':
                        # Remove the content block at changed_idx
                        if changed_idx < len(target_contents):
                            chunk_idx = target_contents[changed_idx][0]
                            # Remove content and following separator if exists
                            if chunk_idx < len(target_chunks):
                                del target_chunks[chunk_idx]
                                # Also remove following separator
                                if chunk_idx < len(target_chunks) and target_chunks[chunk_idx]["type"] == "separator":
                                    del target_chunks[chunk_idx]

                    elif change_type == 'insert':
                        # Translate and insert
                        translated = translate_block(
                            changed_block, prev_block, next_block,
                            prev_target, next_target,
                            source_lang, target_lang
                        )
                        # Find where to insert in target chunks
                        if changed_idx == 0:
                            insert_pos = 0
                        elif changed_idx < len(target_contents):
                            insert_pos = target_contents[changed_idx][0]
                        else:
                            insert_pos = len(target_chunks)

                        # Insert content and separator
                        target_chunks.insert(insert_pos, {"type": "content", "text": translated})
                        # Copy separator from source if available
                        source_sep_idx = new_contents[changed_idx][0] + 1
                        if source_sep_idx < len(new_chunks) and new_chunks[source_sep_idx]["type"] == "separator":
                            target_chunks.insert(insert_pos + 1, {"type": "separator", "text": new_chunks[source_sep_idx]["text"]})

                    else:  # edit
                        # Translate and replace
                        translated = translate_block(
                            changed_block, prev_block, next_block,
                            prev_target, next_target,
                            source_lang, target_lang
                        )
                        if changed_idx < len(target_contents):
                            chunk_idx = target_contents[changed_idx][0]
                            target_chunks[chunk_idx]["text"] = translated
                        else:
                            # Need to add new content
                            target_chunks.append({"type": "content", "text": translated})

                    write_doc(target_lang, target_chunks)
                    await broadcast_to_lang(target_lang, {
                        "type": "doc", "lang": target_lang,
                        "text": chunks_to_text(target_chunks)
                    })

                # Done syncing
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
