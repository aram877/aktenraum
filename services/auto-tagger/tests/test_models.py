import pytest
from aktenraum_core.models import (
    AutoApproveRule,
    DocumentExtraction,
    DocumentType,
    KeyDates,
)
from pydantic import ValidationError


class TestDocumentTypeEnum:
    def test_has_canonical_values(self):
        # The taxonomy is documented in CLAUDE.md; if this changes, update both.
        assert len(DocumentType) == 27

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
        assert ex.ai_title is None
        assert ex.reference_numbers == []
        assert ex.suggested_tags == []
        assert ex.key_dates.issue is None


class TestAutoApproveRule:
    def test_defaults(self):
        rule = AutoApproveRule(document_type=DocumentType.Rechnung)
        assert rule.enabled is False
        assert rule.min_confidence == 0.90
        assert rule.updated_at is None
        assert rule.updated_by is None

    def test_min_confidence_zero_accepted(self):
        rule = AutoApproveRule(
            document_type=DocumentType.Rechnung, min_confidence=0.0
        )
        assert rule.min_confidence == 0.0

    def test_min_confidence_one_accepted(self):
        rule = AutoApproveRule(
            document_type=DocumentType.Rechnung, min_confidence=1.0
        )
        assert rule.min_confidence == 1.0

    def test_min_confidence_below_zero_rejected(self):
        with pytest.raises(ValidationError):
            AutoApproveRule(
                document_type=DocumentType.Rechnung, min_confidence=-0.01
            )

    def test_min_confidence_above_one_rejected(self):
        with pytest.raises(ValidationError):
            AutoApproveRule(
                document_type=DocumentType.Rechnung, min_confidence=1.01
            )

    def test_unknown_document_type_rejected(self):
        with pytest.raises(ValidationError):
            AutoApproveRule(document_type="NotARealType")
