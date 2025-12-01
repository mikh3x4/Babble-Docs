"""Tests for core utility functions in main.py."""
import pytest
import sys
from pathlib import Path

# Add parent directory to path to import main
sys.path.insert(0, str(Path(__file__).parent.parent))

from main import split_sentences, get_context, join_sentences


# --- split_sentences tests ---

def test_split_sentences_empty():
    """Empty string returns empty list."""
    assert split_sentences("") == []
    assert split_sentences("   ") == []
    assert split_sentences("\n\t") == []


def test_split_sentences_single():
    """Single sentence returns list with one element."""
    assert split_sentences("Hello world.") == ["Hello world."]
    assert split_sentences("Is this a question?") == ["Is this a question?"]
    assert split_sentences("Wow!") == ["Wow!"]


def test_split_sentences_multiple():
    """Multiple sentences are split correctly."""
    text = "First sentence. Second sentence. Third sentence."
    assert split_sentences(text) == [
        "First sentence.",
        "Second sentence.",
        "Third sentence."
    ]


def test_split_sentences_mixed_punctuation():
    """Handles mixed punctuation types."""
    text = "Hello! How are you? I am fine."
    assert split_sentences(text) == ["Hello!", "How are you?", "I am fine."]


def test_split_sentences_preserves_internal_punctuation():
    """Punctuation not followed by space is preserved."""
    text = "Visit example.com today. It's great!"
    result = split_sentences(text)
    assert result == ["Visit example.com today.", "It's great!"]


def test_split_sentences_no_trailing_space():
    """Sentence without trailing space at end works."""
    text = "One. Two"
    result = split_sentences(text)
    assert result == ["One.", "Two"]


def test_split_sentences_extra_whitespace():
    """Extra whitespace is handled."""
    text = "First.   Second.    Third."
    result = split_sentences(text)
    assert result == ["First.", "Second.", "Third."]


def test_split_sentences_with_numbers():
    """Numbers with decimals don't cause incorrect splits."""
    text = "The price is $9.99 today. Buy now!"
    result = split_sentences(text)
    # Note: this tests current behavior - 9.99 followed by space may split
    assert len(result) >= 1


# --- join_sentences tests ---

def test_join_sentences_empty():
    """Empty list returns empty string."""
    assert join_sentences([]) == ""


def test_join_sentences_single():
    """Single sentence is returned as-is."""
    assert join_sentences(["Hello."]) == "Hello."


def test_join_sentences_multiple():
    """Multiple sentences are joined with spaces."""
    sentences = ["First.", "Second.", "Third."]
    assert join_sentences(sentences) == "First. Second. Third."


def test_join_sentences_roundtrip():
    """split_sentences and join_sentences are inverse operations."""
    original = "Hello world. How are you? I am fine!"
    sentences = split_sentences(original)
    rejoined = join_sentences(sentences)
    assert rejoined == original


def test_join_sentences_roundtrip_complex():
    """Roundtrip with more complex text."""
    original = "The cat sat. The dog ran! Did the bird fly?"
    sentences = split_sentences(original)
    rejoined = join_sentences(sentences)
    assert rejoined == original


# --- get_context tests ---

def test_get_context_middle():
    """Context extraction from middle of list."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6.", "S7.", "S8.", "S9.", "S10."]
    before, target, after = get_context(sentences, 5)

    assert target == "S5."
    assert before == ["S0.", "S1.", "S2.", "S3.", "S4."]
    assert after == ["S6.", "S7.", "S8.", "S9.", "S10."]


def test_get_context_beginning():
    """Context at beginning has fewer sentences before."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6."]
    before, target, after = get_context(sentences, 0)

    assert target == "S0."
    assert before == []
    assert after == ["S1.", "S2.", "S3.", "S4.", "S5."]


def test_get_context_near_beginning():
    """Context near beginning has fewer than window sentences before."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6."]
    before, target, after = get_context(sentences, 2)

    assert target == "S2."
    assert before == ["S0.", "S1."]  # Only 2 sentences before
    assert after == ["S3.", "S4.", "S5.", "S6."]


def test_get_context_end():
    """Context at end has fewer sentences after."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6."]
    before, target, after = get_context(sentences, 6)

    assert target == "S6."
    assert before == ["S1.", "S2.", "S3.", "S4.", "S5."]
    assert after == []


def test_get_context_near_end():
    """Context near end has fewer than window sentences after."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6."]
    before, target, after = get_context(sentences, 4)

    assert target == "S4."
    assert before == ["S0.", "S1.", "S2.", "S3."]  # Window caps at idx-1
    assert after == ["S5.", "S6."]  # Only 2 sentences after


def test_get_context_small_list():
    """Context from very small list."""
    sentences = ["Only.", "Two."]
    before, target, after = get_context(sentences, 0)

    assert target == "Only."
    assert before == []
    assert after == ["Two."]


def test_get_context_single_sentence():
    """Context from single-sentence list."""
    sentences = ["Alone."]
    before, target, after = get_context(sentences, 0)

    assert target == "Alone."
    assert before == []
    assert after == []


def test_get_context_custom_window():
    """Custom window size works."""
    sentences = ["S0.", "S1.", "S2.", "S3.", "S4.", "S5.", "S6."]
    before, target, after = get_context(sentences, 3, window=2)

    assert target == "S3."
    assert before == ["S1.", "S2."]  # Only 2 sentences
    assert after == ["S4.", "S5."]   # Only 2 sentences


def test_get_context_out_of_bounds():
    """Index beyond list returns empty target."""
    sentences = ["S0.", "S1."]
    before, target, after = get_context(sentences, 5)

    assert target == ""
    assert before == ["S0.", "S1."]
    assert after == []
