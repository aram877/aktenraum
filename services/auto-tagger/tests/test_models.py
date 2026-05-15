import pytest
from aktenraum_core.models import DocumentExtraction, DocumentType, KeyDates
from pydantic import ValidationError


class TestDocumentTypeEnum:
    def test_has_canonical_values(self):
        # The taxonomy is documented in CLAUDE.md; if this changes, update both.
        assert len(DocumentType) == 21

    def test_known_values_round_trip(self):
        for v in ["Rechnung", "Vertrag", "Kontoauszug", "Sonstiges", "Bescheid"]:
            assert DocumentType(v).value == v


class TestDocumentExtractionValidation:
    def _base(self, **overrides):
        kwargs = dict(
            document_type=DocumentType.Rechnung,
            correspondent="X",
            key_dates=KeyDates(),
            summary_de="Satz eins. Satz zwei. Satz drei.",
            confidence=0.9,
        )
        kwargs.update(overrides)
        return kwargs

    def test_minimal_valid_construction(self):
        DocumentExtraction(**self._base())

    def test_rejects_unknown_document_type(self):
        with pytest.raises(ValidationError):
            DocumentExtraction(**self._base(document_type="NotAType"))

    def test_rejects_confidence_above_one(self):
        with pytest.raises(ValidationError):
            DocumentExtraction(**self._base(confidence=1.5))

    def test_rejects_confidence_below_zero(self):
        with pytest.raises(ValidationError):
            DocumentExtraction(**self._base(confidence=-0.1))

    def test_accepts_confidence_at_boundaries(self):
        DocumentExtraction(**self._base(confidence=0.0))
        DocumentExtraction(**self._base(confidence=1.0))

    def test_coerces_int_to_str_in_reference_numbers(self):
        # Real-world: Ollama small models occasionally emit integers in
        # list-of-string fields; CoercedStr lets us tolerate that.
        ex = DocumentExtraction(**self._base(reference_numbers=[42, "INV-1"]))
        assert ex.reference_numbers == ["42", "INV-1"]

    def test_coerces_int_to_str_in_suggested_tags(self):
        ex = DocumentExtraction(**self._base(suggested_tags=[1, 2, "Vertrag"]))
        assert ex.suggested_tags == ["1", "2", "Vertrag"]

    def test_coerces_none_to_empty_list_for_reference_numbers(self):
        # Local models often emit null for empty array fields despite the
        # schema. Coerce None → [] so a representation choice doesn't fail
        # the whole extraction.
        ex = DocumentExtraction(**self._base(reference_numbers=None))
        assert ex.reference_numbers == []

    def test_coerces_none_to_empty_list_for_suggested_tags(self):
        ex = DocumentExtraction(**self._base(suggested_tags=None))
        assert ex.suggested_tags == []

    def test_optional_fields_default_correctly(self):
        ex = DocumentExtraction(**self._base())
        assert ex.monetary_amount is None
        assert ex.ai_title is None
        assert ex.reference_numbers == []
        assert ex.suggested_tags == []
        assert ex.key_dates.issue is None
