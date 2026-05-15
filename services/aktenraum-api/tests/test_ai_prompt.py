from aktenraum_core.models import DocumentType

from aktenraum_api.ai.prompt import build_messages


def _system_text(messages: list[dict]) -> str:
    return next(m["content"] for m in messages if m["role"] == "system")


def test_prompt_includes_every_document_type():
    text = _system_text(build_messages("test", correspondents=[]))
    for dt in DocumentType:
        assert dt.value in text


def test_prompt_lists_known_correspondents():
    text = _system_text(
        build_messages("test", correspondents=["Telekom", "Stadtwerke München"])
    )
    assert "Bekannte Korrespondenten" in text
    assert "Telekom" in text
    assert "Stadtwerke München" in text


def test_prompt_caps_correspondents_at_200():
    text = _system_text(
        build_messages("test", correspondents=[f"Corr-{i}" for i in range(500)])
    )
    assert "Corr-199" in text
    assert "Corr-200" not in text
    assert "Corr-499" not in text


def test_prompt_includes_date_rules():
    text = _system_text(build_messages("test", correspondents=[]))
    assert "Datumsregeln" in text
    assert "aus 2023" in text
    assert "Q1" in text
    assert "letzten Monat" in text


def test_prompt_notes_amount_filter_unavailable():
    # The generic monetary_amount field was retired; the prompt now warns
    # the LLM that no betragsbezogene Felder exist on the filter.
    text = _system_text(build_messages("test", correspondents=[]))
    assert "KEINE betragsbezogenen Felder" in text


def test_prompt_has_at_least_four_examples():
    text = _system_text(build_messages("test", correspondents=[]))
    assert text.count("Beispiel:") >= 4


def test_user_message_is_query_verbatim():
    msgs = build_messages("Lohn 2023", correspondents=[])
    assert msgs[1] == {"role": "user", "content": "Lohn 2023"}


def test_prompt_handles_empty_correspondents():
    text = _system_text(build_messages("test", correspondents=[]))
    assert "(keine bekannt)" in text


def test_prompt_lists_known_tags():
    text = _system_text(
        build_messages(
            "test",
            correspondents=[],
            tags=["Lebenslauf", "Versicherung", "Auto"],
        )
    )
    assert "Bekannte Tags" in text
    assert "Lebenslauf" in text
    assert "Versicherung" in text
    assert "Auto" in text


def test_prompt_caps_tags_at_200():
    text = _system_text(
        build_messages(
            "test", correspondents=[], tags=[f"Tag-{i}" for i in range(500)]
        )
    )
    assert "Tag-199" in text
    assert "Tag-200" not in text


def test_prompt_handles_empty_tag_list():
    text = _system_text(build_messages("test", correspondents=[], tags=[]))
    # The "Bekannte Tags" section still renders so the schema shape is stable;
    # an empty list collapses to the same "(keine bekannt)" sentinel as
    # correspondents.
    assert "Bekannte Tags" in text
    assert text.count("(keine bekannt)") >= 2


def test_prompt_includes_lebenslauf_few_shot():
    """Anchor exemplar that demonstrates picking a tag over an unreliable
    document_type — the user's CV case (Arbeitszeugnis vs. Lebenslauf)."""
    text = _system_text(build_messages("test", correspondents=[]))
    assert "Mein Lebenslauf" in text
    # The exemplar's filter must contain the tag so the LLM sees the mapping.
    assert '"tags": ["Lebenslauf"]' in text
