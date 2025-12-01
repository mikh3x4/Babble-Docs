# Babbel Docs - Agent Task List

This file contains TODO items for sub-agents to implement. Each task should be completable in one session.

## Project Overview

Babbel Docs is a collaborative document editor where users can view/edit documents in different languages. Edits are automatically translated and propagated to all language versions using the Anthropic API.

**Current State**: Basic prototype working with:
- WebSocket-based real-time sync
- Sentence-level edit detection
- Translation using Claude
- Visual feedback during translation

## Architecture

```
main.py          - All backend logic (FastAPI, WebSocket, translation)
static/index.html - Frontend (vanilla JS)
docs/*.txt       - Document storage per language
```

## How to Run

```bash
source venv/bin/activate
python main.py
# Open http://localhost:8000
```

## How to Test

```bash
pytest tests/ -v
```

---

## TODO List

### Task 1: Handle sentence deletion
**Status**: Not started
**File**: `main.py`
**Description**: Currently, editing a sentence works, but if a user deletes a sentence entirely, the other language versions don't update correctly. Implement sentence deletion propagation.
**Acceptance Criteria**:
- When a sentence is removed from one language, remove the corresponding sentence from all other languages
- Handle edge cases (deleting first/last sentence)

### Task 2: Handle sentence insertion
**Status**: Not started
**File**: `main.py`
**Description**: When a user adds a new sentence (not just edits an existing one), translate and insert it into all language versions at the correct position.
**Acceptance Criteria**:
- Detect when a new sentence is added vs an existing one edited
- Translate and insert at the correct index in other languages

### Task 3: Add connection status indicator
**Status**: Not started
**File**: `static/index.html`
**Description**: Show how many users are currently connected and what languages they're viewing.
**Acceptance Criteria**:
- Display "3 users online (2 en, 1 pl)" or similar
- Update in real-time as users connect/disconnect

### Task 4: Add sentence-level highlighting during translation
**Status**: Not started
**File**: `static/index.html`
**Description**: Instead of just showing "translating sentence X", visually highlight the actual sentence in the editor that's being translated.
**Acceptance Criteria**:
- Render sentences as individual spans (or use contenteditable divs)
- Add yellow/orange background to sentence being translated
- Remove highlight when translation completes

### Task 5: Add basic tests
**Status**: Not started
**Files**: `tests/test_main.py`
**Description**: Write tests for the core functions: sentence splitting, context extraction.
**Acceptance Criteria**:
- Test `split_sentences()` with various inputs
- Test `get_context()` edge cases
- Test `join_sentences()`

### Task 6: Add error handling for API failures
**Status**: Not started
**File**: `main.py`
**Description**: Handle cases where the Anthropic API fails (rate limits, network errors, etc).
**Acceptance Criteria**:
- Catch API exceptions
- Broadcast error message to clients
- Allow retry

### Task 7: Support for more languages
**Status**: Not started
**File**: `main.py`, `static/index.html`
**Description**: Add support for additional languages (German, Spanish, French, etc).
**Acceptance Criteria**:
- Add to LANGUAGES dict in main.py
- Add to language selector in HTML
- Test that translations work correctly

### Task 8: Persist edit history
**Status**: Not started
**File**: `main.py`
**Description**: Keep a log of edits so users can see what changed and potentially undo.
**Acceptance Criteria**:
- Save each edit with timestamp to a JSON file
- Implement basic undo (revert to previous version)

---

## Coding Style

- Keep code short and elegant
- Prefer functional style over OOP
- Minimize number of files
- Prioritize readability over extensibility
