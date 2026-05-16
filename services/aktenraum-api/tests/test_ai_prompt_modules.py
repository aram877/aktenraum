from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType

from aktenraum_api.ai.prompt_modules import (
    MODULES,
    field_labels_for,
    module_for,
    parse_document_type,
)


def test_every_document_type_has_a_module():
    """Integrity guard so a new doc type can't ship without a module."""
    for dt in DocumentType:
        assert dt in MODULES, dt


def test_modules_with_examples_have_a_hint():
    """A module that ships an answer_example without a hint would render
    examples but no field guidance — confusing. Allow blank for types
    that have no useful pass-2 fields (e.g. Sonstiges)."""
    for dt, mod in MODULES.items():
        if not mod.answer_example:
            continue
        # An answer_example without hint or labels makes the prompt
        # rules-less; reject in tests.
        assert mod.answer_hint or field_labels_for(dt), dt


def test_field_labels_resolve_from_type_field_schema():
    """Sanity-check: the helper returns exactly what TYPE_FIELD_SCHEMA holds."""
    for dt, fields in TYPE_FIELD_SCHEMA.items():
        expected = [f.label_de for f in fields]
        assert field_labels_for(dt) == expected, dt


def test_field_labels_empty_for_sonstiges():
    assert field_labels_for(DocumentType.Sonstiges) == []


def test_module_for_returns_default_for_sonstiges():
    mod = module_for(DocumentType.Sonstiges)
    assert mod.filter_examples == ()
    assert mod.answer_example == ""


def test_parse_document_type_round_trip():
    """Strings coming back from `_doc_to_summary` / candidates carry the
    enum's German value; the parser must round-trip every enum."""
    for dt in DocumentType:
        assert parse_document_type(dt.value) == dt


def test_parse_document_type_handles_unknown():
    assert parse_document_type(None) is None
    assert parse_document_type("") is None
    assert parse_document_type("Nope") is None


def test_salary_module_demonstrates_gehaltsabrechnung_fields():
    """The salary answer example must reference the canonical fields so
    a small LLM learns the right output shape."""
    mod = MODULES[DocumentType.Gehaltsabrechnung]
    assert "Bruttogehalt" in mod.answer_example
    assert "Nettogehalt" in mod.answer_example
    assert "[Quelle:" in mod.answer_example


def test_rechnung_module_demonstrates_gesamtbetrag():
    mod = MODULES[DocumentType.Rechnung]
    assert "Gesamtbetrag" in mod.answer_example
    assert "[Quelle:" in mod.answer_example


def test_versicherung_module_demonstrates_jahrespraemie():
    mod = MODULES[DocumentType.Versicherung]
    assert "Jahresprämie" in mod.answer_example


def test_kfz_module_filter_example_targets_tuv_field():
    mod = MODULES[DocumentType.Kfz]
    assert mod.filter_examples
    # The filter prompt example asks Paperless to narrow on Kfz docs;
    # the per-type module's answer example must teach the model that
    # "Nächste HU/TÜV" is the canonical field to read.
    assert "HU" in mod.answer_example
