# Babbel Docs

A collaborative document editor with real-time translation. Multiple users can edit the same document in different languages, and changes automatically propagate with translations.

## Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install dependencies
pip install -r requirements.txt

# Configure API key
cp .env.example .env
# Edit .env and add your Anthropic API key
```

## Run

```bash
python main.py
```

Open http://localhost:8000 in your browser. Open multiple tabs with different languages to see real-time translation in action.

## How It Works

1. User selects a language (English, Polish, or Mandarin)
2. User types in the editor - changes are detected at the sentence level
3. When a sentence is edited, it's translated to all other languages using Claude
4. All connected clients see a "translating" indicator while translation is in progress
5. Once complete, all language versions are updated

## Files

- `main.py` - FastAPI backend with WebSocket handling and translation
- `static/index.html` - Single-page frontend with editor
- `docs/` - Document storage (one .txt file per language)

## Architecture

- **Real-time sync**: WebSockets for instant updates
- **Translation**: Anthropic Claude API with context-aware prompts
- **Storage**: Plain text files (one per language)
- **Conflict resolution**: Last-write-wins
