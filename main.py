"""
Babbel Docs - Collaborative Translation Editor
A single-file backend serving a real-time translated document editor.
"""
import os
import re
import json
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import anthropic

load_dotenv()

app = FastAPI()
DOCS_DIR = Path("docs")
DOCS_DIR.mkdir(exist_ok=True)
LANGUAGES = {"en": "English", "pl": "Polish", "zh": "Mandarin Chinese"}

# Connected WebSocket clients: {websocket: language}
clients: dict[WebSocket, str] = {}

# --- Document Storage ---

def get_doc_path(lang: str) -> Path:
    return DOCS_DIR / f"{lang}.txt"

def read_doc(lang: str) -> str:
    path = get_doc_path(lang)
    return path.read_text() if path.exists() else ""

def write_doc(lang: str, content: str):
    get_doc_path(lang).write_text(content)

def split_sentences(text: str) -> list[str]:
    """Split text into sentences. Handles ., !, ? followed by space or end."""
    if not text.strip():
        return []
    # Split on sentence-ending punctuation followed by space or end
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    return [p for p in parts if p]

def join_sentences(sentences: list[str]) -> str:
    return " ".join(sentences)

def get_context(sentences: list[str], idx: int, window: int = 5) -> tuple[list[str], str, list[str]]:
    """Get sentences before, the target sentence, and sentences after."""
    before = sentences[max(0, idx - window):idx]
    target = sentences[idx] if idx < len(sentences) else ""
    after = sentences[idx + 1:idx + 1 + window]
    return before, target, after

# --- Translation ---

class TranslationError(Exception):
    """Raised when translation fails."""
    pass

def translate_sentence(sentence: str, context_before: list[str], context_after: list[str],
                       source_lang: str, target_lang: str) -> str:
    """Translate a single sentence using Claude, with surrounding context."""
    try:
        client = anthropic.Anthropic()

        context_text = ""
        if context_before:
            context_text += f"Previous sentences (for context only):\n{join_sentences(context_before)}\n\n"
        if context_after:
            context_text += f"Following sentences (for context only):\n{join_sentences(context_after)}\n\n"

        prompt = f"""{context_text}Translate this single sentence from {LANGUAGES[source_lang]} to {LANGUAGES[target_lang]}:
"{sentence}"

Return ONLY the translated sentence, nothing else. No quotes."""

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.content[0].text.strip()
    except anthropic.RateLimitError:
        raise TranslationError("Rate limit exceeded. Please wait and try again.")
    except anthropic.APIConnectionError:
        raise TranslationError("Network error. Check your connection.")
    except anthropic.APIError as e:
        raise TranslationError(f"API error: {e.message}")

# --- WebSocket Broadcasting ---

async def broadcast(message: dict, exclude: WebSocket = None):
    """Send message to all connected clients except excluded one."""
    dead = []
    for ws in clients:
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                dead.append(ws)
    for ws in dead:
        clients.pop(ws, None)

async def broadcast_to_language(lang: str, message: dict, exclude: WebSocket = None):
    """Send message only to clients viewing a specific language."""
    for ws, ws_lang in list(clients.items()):
        if ws_lang == lang and ws != exclude:
            try:
                await ws.send_json(message)
            except:
                clients.pop(ws, None)

async def broadcast_connection_stats():
    """Broadcast current connection stats to all clients."""
    from collections import Counter
    lang_counts = Counter(clients.values())
    await broadcast({
        "type": "connection_stats",
        "total": len(clients),
        "by_language": dict(lang_counts)
    })

# --- WebSocket Handler ---

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    clients[ws] = "en"  # default language
    await broadcast_connection_stats()

    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type")

            if msg_type == "load":
                # Client wants to load a language version
                lang = data.get("language", "en")
                if clients[ws] != lang:
                    clients[ws] = lang
                    await broadcast_connection_stats()
                await ws.send_json({"type": "content", "language": lang, "content": read_doc(lang)})

            elif msg_type == "delete":
                # Client deleted a sentence
                source_lang = data["language"]
                sentence_idx = data["sentence_index"]
                full_content = data["full_content"]

                # Save the source language
                write_doc(source_lang, full_content)

                # Delete the same sentence from all other languages
                for target_lang in LANGUAGES:
                    if target_lang == source_lang:
                        continue

                    target_sentences = split_sentences(read_doc(target_lang))
                    if sentence_idx < len(target_sentences):
                        del target_sentences[sentence_idx]
                        new_content = join_sentences(target_sentences)
                        write_doc(target_lang, new_content)

                        await broadcast_to_language(target_lang, {
                            "type": "content",
                            "language": target_lang,
                            "content": new_content
                        })

            elif msg_type == "insert":
                # Client inserted a new sentence
                source_lang = data["language"]
                sentence_idx = data["sentence_index"]
                new_sentence = data["new_sentence"]
                full_content = data["full_content"]

                # Save the source language
                write_doc(source_lang, full_content)

                # Notify translation in progress
                await broadcast({
                    "type": "translating",
                    "sentence_index": sentence_idx,
                    "source_language": source_lang
                }, exclude=ws)

                # Get context for translation
                sentences = split_sentences(full_content)
                before, _, after = get_context(sentences, sentence_idx)

                # Translate and insert in other languages
                try:
                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue

                        target_sentences = split_sentences(read_doc(target_lang))

                        # Translate the new sentence
                        translated = translate_sentence(
                            new_sentence, before, after, source_lang, target_lang
                        )

                        # Insert at the correct position
                        target_sentences.insert(sentence_idx, translated)

                        new_content = join_sentences(target_sentences)
                        write_doc(target_lang, new_content)

                        await broadcast_to_language(target_lang, {
                            "type": "content",
                            "language": target_lang,
                            "content": new_content
                        })

                    await broadcast({"type": "translation_complete", "sentence_index": sentence_idx})
                except TranslationError as e:
                    await broadcast({
                        "type": "translation_error",
                        "sentence_index": sentence_idx,
                        "error": str(e)
                    })

            elif msg_type == "edit":
                # Client made an edit
                source_lang = data["language"]
                sentence_idx = data["sentence_index"]
                new_sentence = data["new_sentence"]
                full_content = data["full_content"]

                # Save the source language immediately
                write_doc(source_lang, full_content)

                # Notify all clients that translation is in progress
                await broadcast({
                    "type": "translating",
                    "sentence_index": sentence_idx,
                    "source_language": source_lang
                }, exclude=ws)

                # Get context for translation
                sentences = split_sentences(full_content)
                before, _, after = get_context(sentences, sentence_idx)

                # Translate to other languages
                try:
                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue

                        # Read current target doc
                        target_content = read_doc(target_lang)
                        target_sentences = split_sentences(target_content)

                        # Ensure we have enough sentences (pad if needed)
                        while len(target_sentences) <= sentence_idx:
                            target_sentences.append("")

                        # Translate the sentence
                        translated = translate_sentence(
                            new_sentence, before, after, source_lang, target_lang
                        )
                        target_sentences[sentence_idx] = translated

                        # Save and broadcast
                        new_content = join_sentences(target_sentences)
                        write_doc(target_lang, new_content)

                        await broadcast_to_language(target_lang, {
                            "type": "content",
                            "language": target_lang,
                            "content": new_content
                        })

                    # Notify translation complete
                    await broadcast({"type": "translation_complete", "sentence_index": sentence_idx})
                except TranslationError as e:
                    await broadcast({
                        "type": "translation_error",
                        "sentence_index": sentence_idx,
                        "error": str(e)
                    })

    except WebSocketDisconnect:
        clients.pop(ws, None)
        await broadcast_connection_stats()

# --- Static Files ---

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
