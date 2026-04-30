import json

import pytest

from auto_tagger.models import DocumentExtraction, DocumentType, KeyDates
from auto_tagger.tagger import (
    _example_payload,
    _route_lifecycle_tags,
    _split_csv,
    _truncate_text,
)


def _make_extraction(doc_type: str, confidence: float) -> DocumentExtraction:
    return DocumentExtraction(
        document_type=DocumentType(doc_type),
        correspondent="Test Sender",
        key_dates=KeyDates(),
        summary_de="Satz eins. Satz zwei. Satz drei.",
        confidence=confidence,
    )


class TestRouteLifecycleTags:
    @pytest.mark.parametrize(
        "doc_type,confidence,expected",
        [
            # In allowlist + above threshold → auto-approve
            ("Rechnung", 0.95, ["ai-approved"]),
            ("Rechnung", 1.0, ["ai-approved"]),
            ("Kontoauszug", 0.96, ["ai-approved"]),
            # In allowlist but below auto-approve threshold → pending
            ("Rechnung", 0.94, ["ai-pending"]),
            ("Rechnung", 0.70, ["ai-pending"]),
            # Below low-confidence threshold + in allowlist → pending + flag
            ("Rechnung", 0.50, ["ai-pending", "ai-low-confidence"]),
            # Not in allowlist (any confidence) → pending
            ("Vertrag", 0.99, ["ai-pending"]),
            ("Versicherung", 1.0, ["ai-pending"]),
            ("Sonstiges", 0.90, ["ai-pending"]),
            # Not in allowlist + low confidence → pending + flag
            ("Sonstiges", 0.30, ["ai-pending", "ai-low-confidence"]),
            ("Vertrag", 0.10, ["ai-pending", "ai-low-confidence"]),
        ],
    )
    def test_routing_matrix(self, make_settings, doc_type, confidence, expected):
        settings = make_settings()
        extraction = _make_extraction(doc_type, confidence)
        assert _route_lifecycle_tags(extraction, settings) == expected

    def test_empty_allowlist_disables_auto_approve_for_all_types(self, make_settings):
        settings = make_settings(AUTO_APPROVE_TYPES="")
        extraction = _make_extraction("Rechnung", 1.0)
        assert _route_lifecycle_tags(extraction, settings) == ["ai-pending"]

    def test_threshold_at_exact_boundary_auto_approves(self, make_settings):
        settings = make_settings(AUTO_APPROVE_CONFIDENCE="0.95")
        extraction = _make_extraction("Rechnung", 0.95)
        assert _route_lifecycle_tags(extraction, settings) == ["ai-approved"]

    def test_low_confidence_flag_skipped_when_auto_approving(self, make_settings):
        # Defensive: auto-approve always wins; low_confidence flag is review-queue
        # signal, irrelevant once the doc skips review entirely.
        settings = make_settings(LOW_CONFIDENCE_THRESHOLD="0.99")
        extraction = _make_extraction("Rechnung", 0.96)
        assert _route_lifecycle_tags(extraction, settings) == ["ai-approved"]


class TestSplitCsv:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            (None, []),
            ("", []),
            ("a", ["a"]),
            ("a, b, c", ["a", "b", "c"]),
            ("  a , , b ", ["a", "b"]),
            (",,,", []),
            ("Vertrag, Industrie", ["Vertrag", "Industrie"]),
        ],
    )
    def test_splits_and_trims(self, raw, expected):
        assert _split_csv(raw) == expected


class TestExamplePayload:
    def test_renders_complete_extraction(self):
        ai_fields = {
            "ai_document_type": "Rechnung",
            "ai_correspondent": "GitHub, Inc.",
            "ai_issue_date": "2022-09-07",
            "ai_due_date": None,
            "ai_expiry_date": None,
            "ai_reference_numbers": "INV-1, REF-2",
            "ai_suggested_tags": "Software, Abo",
            "ai_summary_de": "Beispieltext.",
            "ai_confidence": 0.98,
        }
        parsed = json.loads(_example_payload(ai_fields))
        assert parsed["document_type"] == "Rechnung"
        assert parsed["correspondent"] == "GitHub, Inc."
        assert parsed["key_dates"]["issue"] == "2022-09-07"
        assert parsed["key_dates"]["due"] is None
        assert parsed["reference_numbers"] == ["INV-1", "REF-2"]
        assert parsed["suggested_tags"] == ["Software", "Abo"]
        assert parsed["summary_de"] == "Beispieltext."
        assert parsed["confidence"] == 0.98

    def test_omits_monetary_amount(self):
        # Paperless stores monetary as ISO+amount which conflicts with the
        # German format the prompt asks the model to produce; including it
        # would teach the model the wrong format.
        ai_fields = {
            "ai_document_type": "Rechnung",
            "ai_monetary_amount": "EUR149.99",
        }
        parsed = json.loads(_example_payload(ai_fields))
        assert "monetary_amount" not in parsed

    def test_handles_minimal_fields(self):
        ai_fields = {"ai_document_type": "Sonstiges"}
        parsed = json.loads(_example_payload(ai_fields))
        assert parsed["document_type"] == "Sonstiges"
        assert parsed["correspondent"] is None
        assert parsed["reference_numbers"] == []
        assert parsed["suggested_tags"] == []
        assert parsed["summary_de"] == ""

    def test_emits_valid_utf8_for_german_chars(self):
        ai_fields = {
            "ai_document_type": "Behoerdenbrief",
            "ai_correspondent": "Bürgeramt München",
            "ai_summary_de": "Über die Ausstellung des Personalausweises.",
        }
        out = _example_payload(ai_fields)
        assert "Bürgeramt München" in out  # ensure_ascii=False preserved


class TestTruncateText:
    def test_short_text_unchanged(self):
        assert _truncate_text("hello", max_tokens=100) == "hello"

    def test_long_text_truncated_with_notice(self):
        text = "a" * 5000
        result = _truncate_text(text, max_tokens=100)  # 100 * 4 = 400 chars
        assert len(result) == 400 + len("\n\n[Dokument wurde aufgrund der Länge gekürzt.]")
        assert "gekürzt" in result
