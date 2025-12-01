# Babbel Docs - Agent Tasks

## Quick Start
```bash
source venv/bin/activate && python main.py
# Open http://localhost:8000
```

## Files
- `main.py` - Backend (FastAPI + WebSocket + translation)
- `static/index.html` - Frontend (vanilla JS)
- `docs/*.txt` - Per-language document storage

## Style
Short, elegant, functional. Minimize files. Readability > extensibility.

---

## Tasks

### 1. Sentence deletion
**File**: `main.py`
**Do**: When user deletes a sentence, remove corresponding sentence from all language versions.
**Check**: Delete sentence 2 in English → sentence 2 gone in Polish/Mandarin too.

### 2. Sentence insertion
**File**: `main.py`
**Do**: When user adds a new sentence (not edits existing), translate and insert at correct index in other languages.
**Check**: Add sentence between 1 and 2 → appears translated at same position in other languages.

### 3. Connection status
**File**: `static/index.html`, `main.py`
**Do**: Show "3 users online (2 en, 1 pl)" - update in real-time.
**Check**: Open 3 tabs with different languages, see count update.

### 4. Sentence highlighting during translation
**File**: `static/index.html`
**Do**: Highlight the specific sentence being translated (yellow/orange background) instead of just showing "translating sentence X".
**Check**: Edit in one tab → other tabs show that sentence highlighted until translation completes.

### 5. Basic tests
**File**: `tests/test_main.py`
**Do**: Test `split_sentences()`, `get_context()`, `join_sentences()` with edge cases.
**Check**: `pytest tests/ -v` passes.

### 6. API error handling
**File**: `main.py`
**Do**: Catch Anthropic API failures (rate limits, network). Broadcast error to clients. Allow retry.
**Check**: Disconnect network mid-translation → user sees error message, can retry.

### 7. Edit history
**File**: `main.py`
**Do**: Log edits with timestamps to JSON. Basic undo (revert to previous).
**Check**: Make edits, call undo → reverts to previous state.
