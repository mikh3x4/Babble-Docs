"""Tests for the core document logic: sanitizing, merging, rendering, PDF html."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from main import (
    sanitize_inline_html, merge_blocks, render_blocks, blocks_to_html,
    split_sentences_html, plan_sentence_updates,
)


def make_doc(blocks=None, languages=None):
    return {
        "id": "d1",
        "title": "Test",
        "languages": languages or [
            {"code": "en", "name": "English"},
            {"code": "pl", "name": "Polish"},
        ],
        "blocks": blocks or [],
        "updated_at": 0,
    }


def block(bid, html_by_lang, btype="paragraph", source="en", pending=None, attrs=None):
    return {"id": bid, "type": btype, "attrs": attrs or {}, "content": html_by_lang,
            "source": source, "pending": pending or []}


# --- sanitizer ---------------------------------------------------------------

def test_sanitizer_keeps_formatting_tags():
    assert sanitize_inline_html("a <strong>b</strong> <em>c</em>") == "a <strong>b</strong> <em>c</em>"


def test_sanitizer_strips_script_and_events():
    assert sanitize_inline_html('<script>alert(1)</script>hi') == "alert(1)hi"
    assert sanitize_inline_html('<strong onclick="x()">b</strong>') == "<strong>b</strong>"


def test_sanitizer_restricts_link_protocols():
    assert 'href=""' in sanitize_inline_html('<a href="javascript:alert(1)">x</a>')
    assert 'href="https://a.b"' in sanitize_inline_html('<a href="https://a.b">x</a>')


def test_sanitizer_closes_unclosed_tags():
    assert sanitize_inline_html("<strong>abc") == "<strong>abc</strong>"


def test_sanitizer_escapes_text():
    assert sanitize_inline_html("1 < 2 & 3") == "1 &lt; 2 &amp; 3"


# --- merge_blocks -------------------------------------------------------------

def test_merge_new_block_needs_translation():
    doc = make_doc()
    dirty = merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": "Hello"}], "en")
    assert dirty == ["b1"]
    assert doc["blocks"][0]["content"] == {"en": "Hello"}
    assert doc["blocks"][0]["pending"] == ["pl"]
    assert doc["blocks"][0]["source"] == "en"


def test_merge_unchanged_block_keeps_translations():
    doc = make_doc([block("b1", {"en": "Hello", "pl": "Cześć"})])
    dirty = merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": "Hello"}], "en")
    assert dirty == []
    assert doc["blocks"][0]["content"]["pl"] == "Cześć"


def test_merge_omitted_html_means_untouched():
    # A pl client displaying en fallback text must not overwrite pl content.
    doc = make_doc([block("b1", {"en": "Hello"}, pending=["pl"])])
    dirty = merge_blocks(doc, [{"id": "b1", "type": "paragraph"}], "pl")
    assert dirty == []
    assert doc["blocks"][0]["content"] == {"en": "Hello"}
    assert doc["blocks"][0]["pending"] == ["pl"]


def test_merge_edit_invalidates_other_languages():
    doc = make_doc([block("b1", {"en": "Hello", "pl": "Cześć"})])
    dirty = merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": "Goodbye"}], "en")
    assert dirty == ["b1"]
    assert doc["blocks"][0]["pending"] == ["pl"]
    assert doc["blocks"][0]["content"]["pl"] == "Cześć"  # kept for display until retranslated


def test_merge_type_change_without_text_change_keeps_translations():
    doc = make_doc([block("b1", {"en": "Hello", "pl": "Cześć"})])
    dirty = merge_blocks(doc, [{"id": "b1", "type": "heading", "attrs": {"level": 1}}], "en")
    assert dirty == []
    assert doc["blocks"][0]["type"] == "heading"
    assert doc["blocks"][0]["content"]["pl"] == "Cześć"


def test_merge_deletion():
    doc = make_doc([block("b1", {"en": "One"}), block("b2", {"en": "Two"})])
    merge_blocks(doc, [{"id": "b2", "type": "paragraph"}], "en")
    assert [b["id"] for b in doc["blocks"]] == ["b2"]


def test_merge_reorder_preserves_content():
    doc = make_doc([block("b1", {"en": "One", "pl": "Raz"}), block("b2", {"en": "Two", "pl": "Dwa"})])
    dirty = merge_blocks(doc, [{"id": "b2", "type": "paragraph"}, {"id": "b1", "type": "paragraph"}], "en")
    assert dirty == []
    assert [b["content"]["pl"] for b in doc["blocks"]] == ["Dwa", "Raz"]


def test_merge_duplicate_ids_get_reassigned():
    doc = make_doc()
    merge_blocks(doc, [{"id": "b1", "html": "a", "type": "paragraph"},
                       {"id": "b1", "html": "b", "type": "paragraph"}], "en")
    ids = [b["id"] for b in doc["blocks"]]
    assert len(set(ids)) == 2


def test_merge_code_blocks_skip_translation():
    doc = make_doc()
    dirty = merge_blocks(doc, [{"id": "b1", "type": "code", "html": "x = 1"}], "en")
    assert dirty == []
    assert doc["blocks"][0]["content"]["pl"] == "x = 1"


def test_merge_empty_blocks_skip_translation():
    doc = make_doc()
    dirty = merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": ""}], "en")
    assert dirty == []
    assert doc["blocks"][0]["pending"] == []


# --- sentence splitting ----------------------------------------------------------

def test_split_basic_sentences():
    assert split_sentences_html("One. Two! Three?") == ["One. ", "Two! ", "Three?"]


def test_split_segments_concatenate_losslessly():
    html = "One.  Two <strong>bold</strong>. Three."
    assert "".join(split_sentences_html(html)) == html


def test_split_keeps_tag_spanning_sentences_together():
    # Enders inside an open tag never split (would create invalid fragments),
    # so a mark spanning sentences conservatively keeps the run together.
    assert split_sentences_html("<strong>One. Two.</strong> Three.") == \
        ["<strong>One. Two.</strong> Three."]
    assert split_sentences_html("A <strong>bold</strong>. Next.") == \
        ["A <strong>bold</strong>. ", "Next."]


def test_split_does_not_break_decimals_or_urls():
    assert split_sentences_html("Pi is 3.14 ok") == ["Pi is 3.14 ok"]
    assert split_sentences_html('See <a href="https://a.b/c.d">x</a>. Next.') == \
        ['See <a href="https://a.b/c.d">x</a>. ', "Next."]


def test_split_cjk_without_spaces():
    assert split_sentences_html("你好。再见！") == ["你好。", "再见！"]


def test_split_trailing_text_without_ender():
    assert split_sentences_html("Done. still typing") == ["Done. ", "still typing"]


# --- sentence update planning -------------------------------------------------------

def test_plan_only_edited_sentence_translates():
    old = "One. Two. Three."
    new = "One. 2222. Three."
    tgt = "Raz. Dwa. Trzy."
    ops = plan_sentence_updates(old, new, tgt)
    assert ops == [("keep", "Raz. "), ("translate", "2222. "), ("keep", "Trzy.")]


def test_plan_inserted_sentence():
    ops = plan_sentence_updates("One. Two.", "One. New! Two.", "Raz. Dwa.")
    assert ops == [("keep", "Raz. "), ("translate", "New! "), ("keep", "Dwa.")]


def test_plan_deleted_sentence():
    ops = plan_sentence_updates("One. Two. Three.", "One. Three.", "Raz. Dwa. Trzy.")
    assert ops == [("keep", "Raz. "), ("keep", "Trzy.")]


def test_plan_falls_back_when_unalignable():
    # Target has a different sentence count than the old source: no alignment.
    assert plan_sentence_updates("One. Two.", "One. Two!", "Raz.") is None
    assert plan_sentence_updates(None, "One.", "Raz.") is None


def test_merge_tracks_prev_html_for_sentence_diffing():
    doc = make_doc([block("b1", {"en": "One. Two.", "pl": "Raz. Dwa."})])
    merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": "One. 2222."}], "en")
    assert doc["blocks"][0]["prev_html"] == "One. Two."
    # A second edit while still pending keeps the original prev_html.
    merge_blocks(doc, [{"id": "b1", "type": "paragraph", "html": "One. 3333."}], "en")
    assert doc["blocks"][0]["prev_html"] == "One. Two."


# --- render_blocks ---------------------------------------------------------------

def test_render_translated_language():
    doc = make_doc([block("b1", {"en": "Hello", "pl": "Cześć"})])
    out = render_blocks(doc, "pl")
    assert out[0]["html"] == "Cześć"
    assert out[0]["pending"] is False


def test_render_falls_back_to_source_and_flags_pending():
    doc = make_doc([block("b1", {"en": "Hello"}, pending=["pl"])])
    out = render_blocks(doc, "pl")
    assert out[0]["html"] == "Hello"
    assert out[0]["pending"] is True


# --- PDF html ----------------------------------------------------------------------

def test_blocks_to_html_groups_lists_and_escapes_title():
    doc = make_doc([
        block("b1", {"en": "Title"}, btype="heading", attrs={"level": 1}),
        block("b2", {"en": "one"}, btype="list_item", attrs={"list": "bullet"}),
        block("b3", {"en": "two"}, btype="list_item", attrs={"list": "bullet"}),
        block("b4", {"en": "after"}),
    ])
    doc["title"] = "<Doc>"
    html = blocks_to_html(doc, "en")
    assert "&lt;Doc&gt;" in html
    assert html.count("<ul>") == 1 and html.count("</ul>") == 1
    assert "<li>one</li><li>two</li>" in html
    assert "<h1>Title</h1>" in html


def test_blocks_to_html_switches_list_kind():
    doc = make_doc([
        block("b1", {"en": "a"}, btype="list_item", attrs={"list": "bullet"}),
        block("b2", {"en": "b"}, btype="list_item", attrs={"list": "ordered"}),
    ])
    html = blocks_to_html(doc, "en")
    assert "</ul><ol>" in html


def test_blocks_to_html_nested_lists():
    doc = make_doc([
        block("b1", {"en": "top"}, btype="list_item", attrs={"list": "bullet", "indent": 0}),
        block("b2", {"en": "sub"}, btype="list_item", attrs={"list": "bullet", "indent": 1}),
        block("b3", {"en": "subsub"}, btype="list_item", attrs={"list": "ordered", "indent": 2}),
        block("b4", {"en": "back"}, btype="list_item", attrs={"list": "bullet", "indent": 0}),
    ])
    html = blocks_to_html(doc, "en")
    assert ("<ul><li>top</li><ul><li>sub</li><ol><li>subsub</li></ol></ul>"
            "<li>back</li></ul>") in html


def test_blocks_to_html_clamps_indent_jumps():
    # First item can't start at indent 3; level skips collapse to one level.
    doc = make_doc([
        block("b1", {"en": "a"}, btype="list_item", attrs={"list": "bullet", "indent": 3}),
        block("b2", {"en": "b"}, btype="list_item", attrs={"list": "bullet", "indent": 9}),
    ])
    html = blocks_to_html(doc, "en")
    assert "<ul><li>a</li><ul><li>b</li></ul></ul>" in html


def test_blocks_to_html_nested_list_closes_before_paragraph():
    doc = make_doc([
        block("b1", {"en": "a"}, btype="list_item", attrs={"list": "bullet", "indent": 0}),
        block("b2", {"en": "b"}, btype="list_item", attrs={"list": "bullet", "indent": 1}),
        block("b3", {"en": "after"}),
    ])
    html = blocks_to_html(doc, "en")
    assert "</ul></ul><p>after</p>" in html
