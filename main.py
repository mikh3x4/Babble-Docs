"""
Babbel Docs - Collaborative Translation Editor
A single-file backend serving a real-time translated document editor.
"""
import os
import re
import json
import asyncio
import logging
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import anthropic

# Configure logging to write to both console and file
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('babbel.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

load_dotenv()

app = FastAPI()

@app.on_event("startup")
async def startup_event():
    logger.info("Babbel Docs server starting up")
    logger.info(f"Documents directory: {DOCS_DIR.absolute()}")
    logger.info(f"Supported languages: {list(LANGUAGES.keys())}")
    asyncio.create_task(idle_check_loop())
    logger.debug("Idle check background task started")

DOCS_DIR = Path("docs")
DOCS_DIR.mkdir(exist_ok=True)
HISTORY_FILE = Path("edit_history.json")
LANGUAGES = {"en": "English", "pl": "Polish", "zh": "Mandarin Chinese"}

# Connected WebSocket clients: {websocket: language}
clients: dict[WebSocket, str] = {}

# Idle consistency check state
last_activity_time: float = 0
last_edited_language: str = "en"  # Track which language was most recently edited
IDLE_THRESHOLD_SECONDS = 30
consistency_check_running = False

# --- Document Storage ---

def get_doc_path(lang: str) -> Path:
    return DOCS_DIR / f"{lang}.txt"

def read_doc(lang: str) -> str:
    path = get_doc_path(lang)
    content = path.read_text() if path.exists() else ""
    preview = content[:100] + "..." if len(content) > 100 else content
    logger.debug(f"read_doc({lang}): {len(content)} chars, preview='{preview}'")
    return content

def write_doc(lang: str, content: str):
    preview = content[:100] + "..." if len(content) > 100 else content
    logger.debug(f"write_doc({lang}): {len(content)} chars, preview='{preview}'")
    get_doc_path(lang).write_text(content)

# --- Edit History ---

def load_history() -> list:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text())
    return []

def save_history(history: list):
    HISTORY_FILE.write_text(json.dumps(history, indent=2))

def save_snapshot(operation: str):
    """Save current state of all documents before an operation."""
    from datetime import datetime
    snapshot = {
        "timestamp": datetime.now().isoformat(),
        "operation": operation,
        "documents": {lang: read_doc(lang) for lang in LANGUAGES}
    }
    history = load_history()
    history.append(snapshot)
    # Keep last 50 entries to avoid unbounded growth
    save_history(history[-50:])

def undo_last() -> dict | None:
    """Revert to the previous state. Returns the restored documents or None."""
    history = load_history()
    if len(history) < 1:
        return None
    # Pop the last entry (current state before most recent edit) and restore it
    history.pop()  # Remove the most recent snapshot
    if not history:
        save_history([])
        return None
    previous = history[-1]
    for lang, content in previous["documents"].items():
        write_doc(lang, content)
    save_history(history)
    return previous["documents"]

def split_sentences(text: str) -> list[str]:
    """Split text into sentences. Handles ., newlines, and Chinese punctuation.

    A sentence is anything separated by '.' or newline.
    Returns a list of sentences. Use split_sentences_with_separators() if you
    need to preserve original whitespace/formatting.
    """
    if not text.strip():
        logger.debug(f"split_sentences: empty text, returning []")
        return []
    # Split on sentence-ending punctuation (ASCII and Chinese) OR newlines
    # Chinese punctuation: \u3002 (full stop), \uff01 (exclamation), \uff1f (question mark)
    parts = re.split(r'(?<=[.!?\u3002\uff01\uff1f])\s*|\n+', text.strip())
    result = [p for p in parts if p.strip()]
    logger.debug(f"split_sentences: {len(result)} sentences from {len(text)} chars")
    return result

def split_sentences_with_separators(text: str) -> tuple[list[str], list[str]]:
    """Split text into sentences while preserving the separators between them.

    A sentence is anything separated by '.' or newline.

    Returns:
        tuple of (sentences, separators) where separators[i] is the whitespace
        that appeared after sentences[i]. The last separator is always empty string.
    """
    if not text.strip():
        logger.debug(f"split_sentences_with_separators: empty text, returning ([], [])")
        return [], []

    sentences = []
    separators = []

    # Split by newlines first, then by sentence-ending punctuation within each line
    # Chinese punctuation: \u3002 (full stop), \uff01 (exclamation), \uff1f (question mark)
    lines = text.strip().split('\n')

    for line_idx, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue

        # Pattern: sentence ending with .!? or Chinese punctuation, followed by optional whitespace
        pattern = r'(.*?[.!?\u3002\uff01\uff1f])(\s*)'
        matches = re.findall(pattern, line, re.DOTALL)

        if matches:
            for match_idx, (sentence, separator) in enumerate(matches):
                sentence = sentence.strip()
                if sentence:
                    sentences.append(sentence)
                    # Determine separator: if last match in line and not last line, use newline
                    is_last_match_in_line = match_idx == len(matches) - 1
                    is_last_line = line_idx == len(lines) - 1

                    if is_last_match_in_line and not is_last_line:
                        separators.append('\n')
                    elif separator:
                        separators.append(' ')
                    else:
                        separators.append('')
        else:
            # No sentence-ending punctuation found in this line, treat line as one sentence
            if line:
                sentences.append(line)
                # Use newline separator if not the last line
                is_last_line = line_idx == len(lines) - 1
                if not is_last_line:
                    separators.append('\n')
                else:
                    separators.append('')

    # Ensure last separator is empty (nothing after last sentence)
    if separators:
        separators[-1] = ''

    logger.debug(f"split_sentences_with_separators: {len(sentences)} sentences from {len(text)} chars")
    return sentences, separators

def join_sentences(sentences: list[str], separators: list[str] = None) -> str:
    """Join sentences back together with proper spacing.

    Args:
        sentences: List of sentence strings
        separators: Optional list of separators between sentences. If not provided,
                   sentences are joined with single spaces.

    Returns:
        Joined text with proper spacing.
    """
    if not sentences:
        return ""

    if separators is None or len(separators) != len(sentences):
        # Default behavior: join with single space
        return " ".join(sentences)

    # Use provided separators
    result = []
    for i, sentence in enumerate(sentences):
        result.append(sentence)
        if i < len(sentences) - 1 and separators[i]:
            result.append(separators[i])

    return "".join(result)

def get_context(sentences: list[str], idx: int, window: int = 5) -> tuple[list[str], str, list[str]]:
    """Get sentences before, the target sentence, and sentences after."""
    before = sentences[max(0, idx - window):idx]
    target = sentences[idx] if idx < len(sentences) else ""
    after = sentences[idx + 1:idx + 1 + window]
    logger.debug(f"get_context: idx={idx}, before={len(before)} sentences, target='{target[:50]}...', after={len(after)} sentences")
    return before, target, after

# --- Translation ---

class TranslationError(Exception):
    """Raised when translation fails."""
    pass

def translate_sentence(sentence: str, context_before: list[str], context_after: list[str],
                       source_lang: str, target_lang: str) -> str:
    """Translate a single sentence using Claude, with surrounding context."""
    logger.debug(f"Translating sentence from {source_lang} to {target_lang}: {sentence[:50]}...")
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
        result = response.content[0].text.strip()
        logger.info(f"Translation complete: {source_lang} -> {target_lang}")
        return result
    except anthropic.RateLimitError:
        logger.warning(f"Rate limit hit during translation {source_lang} -> {target_lang}")
        raise TranslationError("Rate limit exceeded. Please wait and try again.")
    except anthropic.APIConnectionError:
        logger.error(f"API connection error during translation {source_lang} -> {target_lang}")
        raise TranslationError("Network error. Check your connection.")
    except anthropic.APIError as e:
        logger.error(f"API error during translation {source_lang} -> {target_lang}: {e.message}")
        raise TranslationError(f"API error: {e.message}")

# --- Consistency Check ---

async def run_consistency_check():
    """Check all language versions for consistency and reconcile if needed.

    Uses the most recently edited language as the source of truth, translating
    its content to all other languages. This respects intentional deletions
    rather than merging all content together.
    """
    global consistency_check_running
    if consistency_check_running:
        logger.debug("Consistency check already running, skipping")
        return

    logger.info("Starting consistency check")
    consistency_check_running = True
    try:
        # Read all documents
        docs = {lang: read_doc(lang) for lang in LANGUAGES}
        sentence_counts = {lang: len(split_sentences(content)) for lang, content in docs.items()}

        # Check if counts differ (indicates sync issue)
        counts = list(sentence_counts.values())
        if not counts or all(c == 0 for c in counts):
            logger.debug("Empty documents, skipping consistency check")
            return  # Empty docs, nothing to reconcile

        if len(set(counts)) == 1:
            logger.debug("All documents have same sentence count, no reconciliation needed")
            return  # All same count, assume in sync

        logger.info(f"Sentence count mismatch detected: {sentence_counts}")
        logger.info(f"Using {last_edited_language} as source of truth (most recently edited)")

        # Notify clients that sync is starting
        logger.info("Broadcasting consistency_check status: started")
        await broadcast({"type": "consistency_check", "status": "started"})

        # Use the most recently edited language as source of truth
        source_lang = last_edited_language
        source_content = docs[source_lang]
        source_sentences = split_sentences(source_content)

        if not source_sentences:
            logger.debug(f"Source language {source_lang} is empty, clearing all documents")
            # Save snapshot before clearing
            save_snapshot("consistency_check")
            for lang in LANGUAGES:
                write_doc(lang, "")
                await broadcast_to_language(lang, {
                    "type": "content",
                    "language": lang,
                    "content": ""
                })
            logger.info("Broadcasting consistency_check status: completed")
            await broadcast({"type": "consistency_check", "status": "completed"})
            logger.info("Consistency check completed - all documents cleared")
            return

        # Use Claude to translate the source to other languages
        client = anthropic.Anthropic()

        prompt = f"""The {LANGUAGES[source_lang]} version of a document is the authoritative version.
Translate it to the other languages while preserving the exact same number of sentences.

=== {LANGUAGES[source_lang]} (SOURCE - this is authoritative) ===
{source_content}

Translate the above to {', '.join(LANGUAGES[lang] for lang in LANGUAGES if lang != source_lang)}.
Each translation must have exactly {len(source_sentences)} sentences, matching the source.

Return your response in this exact JSON format (no other text):
{{
{', '.join(f'  "{lang}": "Full {LANGUAGES[lang]} text here..."' for lang in LANGUAGES if lang != source_lang)}
}}"""

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )

        # Parse response
        response_text = response.content[0].text.strip()
        # Extract JSON from response (handle potential markdown code blocks)
        if "```" in response_text:
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:]

        translations = json.loads(response_text)

        # Save snapshot before reconciliation
        save_snapshot("consistency_check")

        # Keep the source language as-is, update others with translations
        for lang in LANGUAGES:
            if lang == source_lang:
                # Broadcast the source content to ensure clients are in sync
                await broadcast_to_language(lang, {
                    "type": "content",
                    "language": lang,
                    "content": source_content
                })
            elif lang in translations:
                content = translations[lang]
                write_doc(lang, content)
                await broadcast_to_language(lang, {
                    "type": "content",
                    "language": lang,
                    "content": content
                })

        logger.info("Broadcasting consistency_check status: completed")
        await broadcast({"type": "consistency_check", "status": "completed"})
        logger.info("Consistency check completed successfully")

    except Exception as e:
        logger.error(f"Consistency check failed: {e}")
        logger.info("Broadcasting consistency_check status: error")
        await broadcast({"type": "consistency_check", "status": "error", "error": str(e)})
    finally:
        consistency_check_running = False

async def idle_check_loop():
    """Background task that triggers consistency check after idle period."""
    global last_activity_time
    import time

    while True:
        await asyncio.sleep(5)  # Check every 5 seconds

        if last_activity_time == 0:
            continue

        elapsed = time.time() - last_activity_time
        logger.debug(f"idle_check_loop: elapsed={elapsed:.1f}s, threshold={IDLE_THRESHOLD_SECONDS}s, check_running={consistency_check_running}")
        if elapsed >= IDLE_THRESHOLD_SECONDS and not consistency_check_running:
            logger.info(f"idle_check_loop: idle threshold reached ({elapsed:.1f}s), triggering consistency check")
            last_activity_time = 0  # Reset to prevent repeated checks
            await run_consistency_check()

def update_activity(edited_lang: str = None):
    """Update the last activity timestamp and optionally track which language was edited."""
    global last_activity_time, last_edited_language
    import time
    last_activity_time = time.time()
    if edited_lang:
        last_edited_language = edited_lang
    logger.debug(f"update_activity: timestamp set to {last_activity_time}, last_edited_language={last_edited_language}")

# --- WebSocket Broadcasting ---

async def broadcast(message: dict, exclude: WebSocket = None):
    """Send message to all connected clients except excluded one."""
    target_count = len([ws for ws in clients if ws != exclude])
    logger.debug(f"broadcast: type={message.get('type')}, to {target_count} clients (excluding 1: {exclude is not None})")
    dead = []
    for ws in clients:
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                dead.append(ws)
    if dead:
        logger.debug(f"broadcast: removed {len(dead)} dead connections")
    for ws in dead:
        clients.pop(ws, None)

async def broadcast_to_language(lang: str, message: dict, exclude: WebSocket = None):
    """Send message only to clients viewing a specific language."""
    target_count = len([ws for ws, ws_lang in clients.items() if ws_lang == lang and ws != exclude])
    logger.debug(f"broadcast_to_language({lang}): type={message.get('type')}, to {target_count} clients")
    for ws, ws_lang in list(clients.items()):
        if ws_lang == lang and ws != exclude:
            try:
                await ws.send_json(message)
            except:
                logger.debug(f"broadcast_to_language({lang}): removed dead connection")
                clients.pop(ws, None)

async def broadcast_connection_stats():
    """Broadcast current connection stats to all clients."""
    from collections import Counter
    lang_counts = Counter(clients.values())
    logger.debug(f"broadcast_connection_stats: total={len(clients)}, by_language={dict(lang_counts)}")
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
    logger.info(f"New WebSocket connection established. Total clients: {len(clients)}")
    await broadcast_connection_stats()

    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type")
            logger.debug(f"Received message: type={msg_type}, data keys={list(data.keys())}")

            if msg_type == "load":
                # Client wants to load a language version
                lang = data.get("language", "en")
                logger.debug(f"Client loading document for language: {lang}")
                if clients[ws] != lang:
                    clients[ws] = lang
                    await broadcast_connection_stats()
                await ws.send_json({"type": "content", "language": lang, "content": read_doc(lang)})

            elif msg_type == "delete":
                # Client deleted a sentence
                source_lang = data["language"]
                update_activity(source_lang)
                sentence_idx = data["sentence_index"]
                full_content = data["full_content"]
                logger.info(f"Delete operation: sentence {sentence_idx} in {source_lang}")
                logger.debug(f"Delete: full_content length={len(full_content)}")

                # Save snapshot before making changes
                save_snapshot("delete")

                # Save the source language
                write_doc(source_lang, full_content)

                # Broadcast the updated content to all clients viewing the source language
                await broadcast_to_language(source_lang, {
                    "type": "content",
                    "language": source_lang,
                    "content": full_content
                }, exclude=ws)

                # Delete the same sentence from all other languages
                for target_lang in LANGUAGES:
                    if target_lang == source_lang:
                        continue

                    target_sentences, target_separators = split_sentences_with_separators(read_doc(target_lang))
                    logger.debug(f"Delete: {target_lang} has {len(target_sentences)} sentences, deleting idx {sentence_idx}")
                    if sentence_idx < len(target_sentences):
                        deleted_sentence = target_sentences[sentence_idx]
                        logger.debug(f"Delete: removing sentence '{deleted_sentence[:50]}...' from {target_lang}")
                        del target_sentences[sentence_idx]
                        # Also remove the corresponding separator
                        if sentence_idx < len(target_separators):
                            del target_separators[sentence_idx]
                        new_content = join_sentences(target_sentences, target_separators)
                        write_doc(target_lang, new_content)

                        await broadcast_to_language(target_lang, {
                            "type": "content",
                            "language": target_lang,
                            "content": new_content
                        })
                    else:
                        logger.debug(f"Delete: sentence_idx {sentence_idx} out of range for {target_lang} ({len(target_sentences)} sentences)")

            elif msg_type == "insert":
                # Client inserted a new sentence
                source_lang = data["language"]
                update_activity(source_lang)
                sentence_idx = data["sentence_index"]
                new_sentence = data["new_sentence"]
                full_content = data["full_content"]
                logger.info(f"Insert operation: sentence {sentence_idx} in {source_lang}")
                logger.debug(f"Insert: new_sentence='{new_sentence[:50]}...', full_content length={len(full_content)}")

                # Save snapshot before making changes
                save_snapshot("insert")

                # Save the source language
                write_doc(source_lang, full_content)

                # Broadcast the updated content to all clients viewing the source language
                await broadcast_to_language(source_lang, {
                    "type": "content",
                    "language": source_lang,
                    "content": full_content
                }, exclude=ws)

                # Broadcast pending translation with original text to other languages
                for target_lang in LANGUAGES:
                    if target_lang != source_lang:
                        logger.debug(f"Insert: sending pending_translation to {target_lang} for sentence_idx={sentence_idx}")
                        await broadcast_to_language(target_lang, {
                            "type": "pending_translation",
                            "sentence_index": sentence_idx,
                            "original_text": new_sentence,
                            "source_language": source_lang
                        })

                # Get context for translation
                sentences = split_sentences(full_content)
                before, _, after = get_context(sentences, sentence_idx)
                logger.debug(f"Insert: context extracted - {len(before)} sentences before, {len(after)} sentences after")

                # Translate and insert in other languages
                try:
                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue

                        target_sentences, target_separators = split_sentences_with_separators(read_doc(target_lang))
                        logger.debug(f"Insert: {target_lang} has {len(target_sentences)} sentences before insert")

                        # Translate the new sentence
                        translated = translate_sentence(
                            new_sentence, before, after, source_lang, target_lang
                        )
                        logger.debug(f"Insert: translated to {target_lang}: '{translated[:50]}...'")

                        # Insert at the correct position
                        target_sentences.insert(sentence_idx, translated)
                        # Insert a default separator (single space) for the new sentence
                        if sentence_idx < len(target_separators):
                            target_separators.insert(sentence_idx, ' ')
                        else:
                            target_separators.append(' ')
                        logger.debug(f"Insert: {target_lang} now has {len(target_sentences)} sentences after insert")

                        new_content = join_sentences(target_sentences, target_separators)
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
                update_activity(source_lang)
                sentence_idx = data["sentence_index"]
                new_sentence = data["new_sentence"]
                full_content = data["full_content"]
                logger.info(f"Edit operation: sentence {sentence_idx} in {source_lang}")
                logger.debug(f"Edit: new_sentence='{new_sentence[:50]}...', full_content length={len(full_content)}")

                # Save snapshot before making changes
                save_snapshot("edit")

                # Save the source language immediately
                write_doc(source_lang, full_content)

                # Broadcast the updated content to all clients viewing the source language
                await broadcast_to_language(source_lang, {
                    "type": "content",
                    "language": source_lang,
                    "content": full_content
                }, exclude=ws)

                # Broadcast pending translation with original text to other languages
                for target_lang in LANGUAGES:
                    if target_lang != source_lang:
                        logger.debug(f"Edit: sending pending_translation to {target_lang} for sentence_idx={sentence_idx}")
                        await broadcast_to_language(target_lang, {
                            "type": "pending_translation",
                            "sentence_index": sentence_idx,
                            "original_text": new_sentence,
                            "source_language": source_lang
                        })

                # Get context for translation
                sentences = split_sentences(full_content)
                before, _, after = get_context(sentences, sentence_idx)
                logger.debug(f"Edit: context extracted - {len(before)} sentences before, {len(after)} sentences after")

                # Translate to other languages
                try:
                    for target_lang in LANGUAGES:
                        if target_lang == source_lang:
                            continue

                        # Read current target doc
                        target_content = read_doc(target_lang)
                        target_sentences, target_separators = split_sentences_with_separators(target_content)
                        logger.debug(f"Edit: {target_lang} has {len(target_sentences)} sentences, editing idx {sentence_idx}")

                        # Ensure we have enough sentences (pad if needed)
                        original_len = len(target_sentences)
                        while len(target_sentences) <= sentence_idx:
                            target_sentences.append("")
                            target_separators.append(' ')
                        if len(target_sentences) > original_len:
                            logger.debug(f"Edit: padded {target_lang} from {original_len} to {len(target_sentences)} sentences")

                        # Translate the sentence
                        old_sentence = target_sentences[sentence_idx]
                        logger.debug(f"Edit: {target_lang} old sentence: '{old_sentence[:50]}...'")
                        translated = translate_sentence(
                            new_sentence, before, after, source_lang, target_lang
                        )
                        logger.debug(f"Edit: {target_lang} new sentence: '{translated[:50]}...'")
                        target_sentences[sentence_idx] = translated

                        # Save and broadcast
                        new_content = join_sentences(target_sentences, target_separators)
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

            elif msg_type == "undo":
                # Revert to previous state
                logger.info("Undo operation requested")
                restored = undo_last()
                if restored:
                    logger.debug(f"Undo: restored {len(restored)} language documents")
                    # Broadcast updated content to all clients
                    for lang, content in restored.items():
                        logger.debug(f"Undo: broadcasting restored content for {lang}, length={len(content)}")
                        await broadcast_to_language(lang, {
                            "type": "content",
                            "language": lang,
                            "content": content
                        })
                    # Also send to the requesting client
                    client_lang = clients.get(ws, "en")
                    logger.debug(f"Undo: sending content to requesting client (lang={client_lang})")
                    await ws.send_json({
                        "type": "content",
                        "language": client_lang,
                        "content": restored.get(client_lang, "")
                    })
                else:
                    logger.debug("Undo: no history to restore")

    except WebSocketDisconnect:
        clients.pop(ws, None)
        logger.info(f"WebSocket connection closed. Total clients: {len(clients)}")
        await broadcast_connection_stats()

# --- Static Files ---

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Babbel Docs server on 0.0.0.0:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
