import json

import pytest
from aktenraum_core.models import DocumentExtraction, DocumentType, KeyDates

from auto_tagger.tagger import (
    _example_payload,
    _format_history_hint,
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
            # Above threshold (any document type) → auto-approve + auxiliary marker.
            ("Rechnung", 0.90, ["ai-approved", "ai-auto-approved"]),
            ("Rechnung", 1.0, ["ai-approved", "ai-auto-approved"]),
            ("Vertrag", 0.95, ["ai-approved", "ai-auto-approved"]),
            ("Versicherung", 0.99, ["ai-approved", "ai-auto-approved"]),
            ("Sonstiges", 1.0, ["ai-approved", "ai-auto-approved"]),
            # Below auto-approve threshold (and above low-confidence) → pending only.
            ("Rechnung", 0.89, ["ai-pending"]),
            ("Vertrag", 0.70, ["ai-pending"]),
            # Below low-confidence threshold → pending + flag.
            ("Rechnung", 0.50, ["ai-pending", "ai-low-confidence"]),
            ("Sonstiges", 0.30, ["ai-pending", "ai-low-confidence"]),
            ("Vertrag", 0.10, ["ai-pending", "ai-low-confidence"]),
        ],
    )
    def test_routing_matrix(self, make_settings, doc_type, confidence, expected):
        settings = make_settings()
        extraction = _make_extraction(doc_type, confidence)
        assert _route_lifecycle_tags(extraction, settings) == expected

    def test_type_allowlist_is_ignored(self, make_settings):
        # Legacy setting is parsed but no longer consulted — every doc type
        # qualifies for auto-approve once confidence crosses the threshold.
        settings = make_settings(AUTO_APPROVE_TYPES="")
        extraction = _make_extraction("Vertrag", 1.0)
        assert _route_lifecycle_tags(extraction, settings) == [
            "ai-approved",
            "ai-auto-approved",
        ]

    def test_threshold_at_exact_boundary_auto_approves(self, make_settings):
        settings = make_settings(AUTO_APPROVE_CONFIDENCE="0.90")
        extraction = _make_extraction("Rechnung", 0.90)
        assert _route_lifecycle_tags(extraction, settings) == [
            "ai-approved",
            "ai-auto-approved",
        ]

    def test_low_confidence_flag_skipped_when_auto_approving(self, make_settings):
        # Defensive: auto-approve always wins; low_confidence flag is review-queue
        # signal, irrelevant once the doc skips review entirely.
        settings = make_settings(LOW_CONFIDENCE_THRESHOLD="0.99")
        extraction = _make_extraction("Rechnung", 0.96)
        assert _route_lifecycle_tags(extraction, settings) == [
            "ai-approved",
            "ai-auto-approved",
        ]


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
    def _payload(self, ai_fields: dict, **native):
        defaults = {
            "correspondent_name": None,
            "document_type_name": None,
            "created_date": None,
            "tag_names": [],
        }
        defaults.update(native)
        return json.loads(_example_payload(ai_fields, **defaults))

    def test_renders_complete_extraction_native_priority(self):
        # Native fields take priority over their ai_* equivalents — the user
        # may have corrected them post-propagation.
        ai_fields = {
            "ai_document_type": "Sonstiges",  # ← stale AI guess
            "ai_correspondent": "GitHub Inc",  # ← stale AI guess
            "ai_issue_date": "2022-01-01",
            "ai_reference_numbers": "INV-1, REF-2",
            "ai_suggested_tags": "raw, suggestions",
            "ai_summary_de": "Beispieltext.",
            "ai_confidence": 0.98,
        }
        parsed = self._payload(
            ai_fields,
            correspondent_name="GitHub, Inc.",  # ← user-corrected
            document_type_name="Rechnung",  # ← user-corrected
            created_date="2022-09-07",
            tag_names=["Software", "Abo"],
        )
        assert parsed["document_type"] == "Rechnung"
        assert parsed["correspondent"] == "GitHub, Inc."
        assert parsed["key_dates"]["issue"] == "2022-09-07"
        assert parsed["reference_numbers"] == ["INV-1", "REF-2"]
        assert parsed["suggested_tags"] == ["Software", "Abo"]
        assert parsed["summary_de"] == "Beispieltext."
        assert parsed["confidence"] == 0.98

    def test_falls_back_to_ai_fields_when_native_missing(self):
        ai_fields = {
            "ai_document_type": "Rechnung",
            "ai_correspondent": "GitHub, Inc.",
            "ai_issue_date": "2022-09-07",
            "ai_suggested_tags": "tag-a, tag-b",
        }
        parsed = self._payload(ai_fields)
        assert parsed["document_type"] == "Rechnung"
        assert parsed["correspondent"] == "GitHub, Inc."
        assert parsed["key_dates"]["issue"] == "2022-09-07"
        assert parsed["suggested_tags"] == ["tag-a", "tag-b"]

    def test_handles_minimal_fields(self):
        parsed = self._payload({"ai_document_type": "Sonstiges"})
        assert parsed["document_type"] == "Sonstiges"
        assert parsed["correspondent"] is None
        assert parsed["reference_numbers"] == []
        assert parsed["suggested_tags"] == []
        assert parsed["summary_de"] == ""

    def test_emits_valid_utf8_for_german_chars(self):
        ai_fields = {"ai_document_type": "Behoerdenbrief"}
        out = _example_payload(
            ai_fields,
            correspondent_name="Bürgeramt München",
            document_type_name="Behördenbrief",
            created_date=None,
            tag_names=[],
        )
        assert "Bürgeramt München" in out
        assert "Behördenbrief" in out


class TestFormatHistoryHint:
    def test_returns_empty_when_no_history(self):
        assert _format_history_hint({}, "any text") == ""

    def test_returns_empty_when_no_match_in_text(self):
        history = {"Vodafone GmbH": {"Rechnung": 5}}
        assert _format_history_hint(history, "Some unrelated content") == ""

    def test_dominant_type_when_70_pct_threshold_met(self):
        # 5/5 = 100% Rechnung → dominant branch
        history = {"GitHub, Inc.": {"Rechnung": 5}}
        out = _format_history_hint(history, "Receipt from GitHub, Inc. for $10")
        assert "GitHub, Inc." in out
        assert "Rechnung" in out
        assert "5 von 5" in out

    def test_dominant_branch_at_exactly_70_pct(self):
        # 7/10 = 70% Rechnung → dominant branch (boundary)
        history = {"Acme": {"Rechnung": 7, "Mahnung": 3}}
        out = _format_history_hint(history, "Letter from Acme")
        assert "Rechnung" in out
        assert "7 von 10" in out

    def test_distribution_branch_below_threshold(self):
        # 4/7 = 57% → no dominant; show full distribution
        history = {"Mixed Sender": {"Rechnung": 4, "Mahnung": 2, "Vertrag": 1}}
        out = _format_history_hint(history, "Note from Mixed Sender today")
        assert "Mixed Sender" in out
        # Should NOT use the dominant phrasing
        assert "Berücksichtige dies" not in out
        # All three types appear
        for label in ("Rechnung", "Mahnung", "Vertrag"):
            assert label in out

    def test_below_min_samples_uses_distribution_not_dominant(self):
        # Single-sample sender: 1/1 = 100% but n=1 < min — distribution branch.
        history = {"NewSender": {"Rechnung": 1}}
        out = _format_history_hint(history, "Hello from NewSender")
        assert "NewSender" in out
        assert "Berücksichtige dies" not in out

    def test_prefers_longest_match_when_multiple_correspondents_in_text(self):
        # Both "GitHub" and "GitHub, Inc." in history; longer should win.
        history = {
            "GitHub": {"Sonstiges": 3},
            "GitHub, Inc.": {"Rechnung": 5},
        }
        out = _format_history_hint(history, "Receipt from GitHub, Inc. arrived today")
        assert "GitHub, Inc." in out
        assert "Rechnung" in out

    def test_only_searches_first_1000_chars(self):
        # Sender mentioned only after the head window — should not match.
        head_padding = "x" * 1500
        history = {"Bürgeramt München": {"Behördenbrief": 3}}
        text = head_padding + " sender Bürgeramt München"
        assert _format_history_hint(history, text) == ""


class TestTruncateText:
    def test_short_text_unchanged(self):
        assert _truncate_text("hello", max_tokens=100) == "hello"

    def test_long_text_truncated_with_notice(self):
        text = "a" * 5000
        result = _truncate_text(text, max_tokens=100)  # 100 * 4 = 400 chars
        assert len(result) == 400 + len("\n\n[Dokument wurde aufgrund der Länge gekürzt.]")
        assert "gekürzt" in result
