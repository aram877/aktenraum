"""Tests for build_type_specific_prompt."""
from aktenraum_core.llm import build_type_specific_prompt
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType


def test_rechnung_prompt_has_all_fields():
    prompt = build_type_specific_prompt(DocumentType.Rechnung, "text")
    for f in TYPE_FIELD_SCHEMA[DocumentType.Rechnung]:
        assert f.name in prompt


def test_rechnung_prompt_excludes_kfz_fields():
    prompt = build_type_specific_prompt(DocumentType.Rechnung, "text")
    for f in TYPE_FIELD_SCHEMA[DocumentType.Kfz]:
        assert f.name not in prompt


def test_sonstiges_returns_empty_string():
    assert build_type_specific_prompt(DocumentType.Sonstiges, "text") == ""


def test_all_non_empty_types_produce_prompt():
    for doc_type, fields in TYPE_FIELD_SCHEMA.items():
        prompt = build_type_specific_prompt(doc_type, "sample text")
        if fields:
            assert len(prompt) > 50, f"Prompt too short for {doc_type}"
        else:
            assert prompt == ""


def test_prompt_instructs_null_for_missing():
    prompt = build_type_specific_prompt(DocumentType.Gehaltsabrechnung, "text")
    assert "null" in prompt


def test_prompt_contains_ocr_hint():
    prompt = build_type_specific_prompt(DocumentType.Vertrag, "text")
    assert "OCR" in prompt or "Leerzeichen" in prompt
