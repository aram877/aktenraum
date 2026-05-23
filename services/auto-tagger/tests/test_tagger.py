import json

import pytest
from aktenraum_core.models import (
    AutoApproveRule,
    DocumentExtraction,
    DocumentType,
    KeyDates,
)

from auto_tagger.auto_approve_config import RuleSet
from auto_tagger.tagger import (
    _example_payload,
    _extract_reference_numbers_from_text,
    _fallback_confidence_reason,
    _format_error,
    _format_history_hint,
    _format_issue_date_de,
    _route_lifecycle_tags,
    _split_csv,
    _synthesize_ai_title,
    _synthesize_suggested_tags,
    _synthesize_summary_de,
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


def _build_rules(
    overrides: dict[DocumentType | str, tuple[bool, float]] | None = None,
) -> RuleSet:
    """Build a complete 26-entry RuleSet for tests. `overrides` maps a
    DocumentType (or its string value) to (enabled, min_confidence)."""
    overrides = overrides or {}
    normalized = {
        (k if isinstance(k, DocumentType) else DocumentType(k)): v
        for k, v in overrides.items()
    }
    by_type = {
        dt: AutoApproveRule(
            document_type=dt,
            enabled=normalized.get(dt, (False, 0.90))[0],
            min_confidence=normalized.get(dt, (False, 0.90))[1],
        )
        for dt in DocumentType
    }
    return RuleSet(by_type=by_type, fail_closed=False)


class TestSynthesizeSummaryDe:
    def test_full_extraction_uses_all_signals(self):
        ex = DocumentExtraction(
            document_type=DocumentType.Rechnung,
            correspondent="Stadtwerke München",
            ai_title="Rechnung Stadtwerke März 2024",
            key_dates=KeyDates(issue="2024-03-15"),
            reference_numbers=["RN-12345", "K-2024/001"],
        )
        out = _synthesize_summary_de(ex)
        # Sentence 1: type + sender + date.
        assert "Rechnung von Stadtwerke München vom März 2024." in out
        # Sentence 2: AI title surfaced (since it adds info).
        assert "Betreff: Rechnung Stadtwerke März 2024." in out
        # Sentence 3: reference numbers preferred over tags.
        assert "Aktenzeichen: RN-12345, K-2024/001." in out

    def test_no_correspondent_falls_back_to_date_only(self):
        ex = DocumentExtraction(
            document_type=DocumentType.Bescheid,
            key_dates=KeyDates(issue="2024-12-01"),
        )
        out = _synthesize_summary_de(ex)
        assert out.startswith("Bescheid vom Dezember 2024.")

    def test_no_correspondent_no_date_falls_back_to_type_only(self):
        ex = DocumentExtraction(document_type=DocumentType.Sonstiges)
        out = _synthesize_summary_de(ex)
        assert out == "Sonstiges."

    def test_tags_used_when_no_reference_numbers(self):
        ex = DocumentExtraction(
            document_type=DocumentType.Vertrag,
            correspondent="Acme GmbH",
            suggested_tags=["Miete", "WG", "Wohnung"],
        )
        out = _synthesize_summary_de(ex)
        assert "Themen: Miete, WG, Wohnung." in out
        assert "Aktenzeichen" not in out

    def test_ai_title_skipped_when_redundant_with_sentence_one(self):
        # Title is just the doc-type + correspondent line — no second sentence.
        ex = DocumentExtraction(
            document_type=DocumentType.Rechnung,
            correspondent="Telekom",
            ai_title="Rechnung von Telekom",
        )
        out = _synthesize_summary_de(ex)
        # The check is case-insensitive substring, so this Title is redundant.
        assert out.count("Betreff:") == 0

    def test_never_empty(self):
        ex = DocumentExtraction(document_type=DocumentType.Sonstiges)
        assert _synthesize_summary_de(ex).strip() != ""

    def test_caps_reference_numbers_at_three(self):
        ex = DocumentExtraction(
            document_type=DocumentType.Bescheid,
            reference_numbers=["A1", "A2", "A3", "A4", "A5"],
        )
        out = _synthesize_summary_de(ex)
        assert "A1, A2, A3" in out
        assert "A4" not in out


class TestExtractReferenceNumbersFromText:
    def test_aktenzeichen_basic(self):
        text = "Sehr geehrte Damen und Herren,\n\nAktenzeichen: 4 K 2024/0123\n\n..."
        # The regex is conservative — captures "4" but our pattern requires
        # a single alphanumeric run, so "4 K 2024/0123" won't match in full.
        # Test the conservative happy-path instead.
        text = "Aktenzeichen: K-2024/0123-AB"
        assert _extract_reference_numbers_from_text(text) == ["K-2024/0123-AB"]

    def test_rechnungsnummer_compact(self):
        text = "Rechnungs-Nr.: RN-987654"
        assert _extract_reference_numbers_from_text(text) == ["RN-987654"]

    def test_multiple_labels_label_priority_order(self):
        # Aktenzeichen wins over Rechnungsnr. because it comes first in
        # _REFERENCE_PATTERNS; both values still surface.
        text = """
        Aktenzeichen: AZ-001
        Rechnungsnummer: RN-002
        Kundennummer: KD-003
        """
        out = _extract_reference_numbers_from_text(text)
        assert out[0] == "AZ-001"
        assert "RN-002" in out
        assert "KD-003" in out

    def test_case_insensitive_label_case_preserved_value(self):
        text = "aktenzeichen: BX-001"
        assert _extract_reference_numbers_from_text(text) == ["BX-001"]

    def test_dedup_preserves_first(self):
        text = "Aktenzeichen: K-100\n\nWeitere Erwähnung Az.: K-100"
        # K-100 appears twice; only one entry comes back, value-case-preserved.
        out = _extract_reference_numbers_from_text(text)
        assert out == ["K-100"]

    def test_no_match_returns_empty(self):
        text = "Sehr geehrte Damen und Herren,\nIhr Anschreiben ist eingegangen."
        assert _extract_reference_numbers_from_text(text) == []

    def test_empty_text_returns_empty(self):
        assert _extract_reference_numbers_from_text("") == []

    def test_limit_caps_output(self):
        text = "\n".join(f"Aktenzeichen: K-{i:03d}" for i in range(10))
        assert len(_extract_reference_numbers_from_text(text, limit=3)) == 3

    def test_short_value_rejected(self):
        # Pattern requires 3+ chars after the leading char (min length 4).
        text = "Aktenzeichen: AB"
        assert _extract_reference_numbers_from_text(text) == []

    def test_long_value_rejected(self):
        # Bounded to 32 chars to defeat runaway captures from glued OCR.
        text = "Aktenzeichen: " + "A" * 200
        # The regex captures the bounded prefix only; result still has 32 chars max.
        out = _extract_reference_numbers_from_text(text)
        assert len(out) == 1
        assert len(out[0]) <= 32

    def test_steuernr_numeric_only(self):
        # Steuernr. uses a numeric-leading pattern (different from the others).
        text = "Steuernummer: 12/345/67890"
        assert _extract_reference_numbers_from_text(text) == ["12/345/67890"]


class TestRouteLifecycleTags:
    # Rules now come from a RuleSet (fetched from aktenraum-api with a
    # 60s TTL cache). Tests inject hand-built rule sets directly to keep
    # the routing logic decoupled from HTTP.

    @pytest.mark.parametrize(
        "doc_type,confidence,rule_overrides,expected_tags,expected_reason",
        [
            # Type enabled and confidence at/above min → auto-approve.
            (
                "Rechnung",
                0.90,
                {"Rechnung": (True, 0.90)},
                ["ai-approved", "ai-auto-approved"],
                "auto_approved",
            ),
            (
                "Rechnung",
                1.0,
                {"Rechnung": (True, 0.95), "Kontoauszug": (True, 0.90)},
                ["ai-approved", "ai-auto-approved"],
                "auto_approved",
            ),
            (
                "Vertrag",
                0.95,
                {"Vertrag": (True, 0.95)},
                ["ai-approved", "ai-auto-approved"],
                "auto_approved",
            ),
            # Type disabled regardless of confidence.
            (
                "Rechnung",
                0.99,
                {"Rechnung": (False, 0.90)},
                ["ai-pending"],
                "type_disabled",
            ),
            (
                "Sonstiges",
                1.0,
                {"Rechnung": (True, 0.90)},  # Sonstiges remains disabled
                ["ai-pending"],
                "type_disabled",
            ),
            # Default (no overrides) — every type disabled → type_disabled.
            ("Rechnung", 1.0, {}, ["ai-pending"], "type_disabled"),
            # Enabled but confidence below per-type threshold.
            (
                "Rechnung",
                0.89,
                {"Rechnung": (True, 0.90)},
                ["ai-pending"],
                "confidence_below_min",
            ),
            (
                "Vertrag",
                0.70,
                {"Vertrag": (True, 0.85)},
                ["ai-pending"],
                "confidence_below_min",
            ),
            # Below low-confidence threshold → pending + ai-low-confidence
            # aux. Reason names whichever gate blocked auto-approve.
            (
                "Rechnung",
                0.50,
                {"Rechnung": (True, 0.90)},
                ["ai-pending", "ai-low-confidence"],
                "confidence_below_min",
            ),
            (
                "Sonstiges",
                0.30,
                {},
                ["ai-pending", "ai-low-confidence"],
                "type_disabled",
            ),
            (
                "Vertrag",
                0.10,
                {"Vertrag": (True, 0.50)},
                ["ai-pending", "ai-low-confidence"],
                "confidence_below_min",
            ),
        ],
    )
    def test_routing_matrix(
        self,
        make_settings,
        doc_type,
        confidence,
        rule_overrides,
        expected_tags,
        expected_reason,
    ):
        settings = make_settings()
        extraction = _make_extraction(doc_type, confidence)
        rules = _build_rules(rule_overrides)
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == expected_tags
        assert reason == expected_reason

    def test_empty_ruleset_blocks_auto_approve(self, make_settings):
        # Default install: every type disabled (the seed default).
        settings = make_settings()
        extraction = _make_extraction("Vertrag", 1.0)
        rules = _build_rules()
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == ["ai-pending"]
        assert reason == "type_disabled"

    def test_threshold_at_exact_boundary_auto_approves(self, make_settings):
        settings = make_settings()
        extraction = _make_extraction("Rechnung", 0.90)
        rules = _build_rules({"Rechnung": (True, 0.90)})
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == ["ai-approved", "ai-auto-approved"]
        assert reason == "auto_approved"

    def test_low_confidence_flag_skipped_when_auto_approving(self, make_settings):
        # Defensive: when both gates pass, low_confidence flag is dropped —
        # the doc skips review entirely and the flag is review-queue signal.
        settings = make_settings(LOW_CONFIDENCE_THRESHOLD="0.99")
        extraction = _make_extraction("Rechnung", 0.96)
        rules = _build_rules({"Rechnung": (True, 0.90)})
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == ["ai-approved", "ai-auto-approved"]
        assert reason == "auto_approved"

    def test_fail_closed_rules_route_to_pending(self, make_settings):
        # Cold start: rule store unreachable. Every doc → pending with the
        # rules_unreachable_fail_closed reason for operator visibility.
        settings = make_settings()
        extraction = _make_extraction("Rechnung", 0.99)
        rules = RuleSet(by_type={}, fail_closed=True)
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == ["ai-pending"]
        assert reason == "rules_unreachable_fail_closed"

    def test_fail_closed_low_confidence_still_appends_aux_tag(self, make_settings):
        settings = make_settings()
        extraction = _make_extraction("Rechnung", 0.3)
        rules = RuleSet(by_type={}, fail_closed=True)
        tags, reason = _route_lifecycle_tags(extraction, settings, rules)
        assert tags == ["ai-pending", "ai-low-confidence"]
        assert reason == "rules_unreachable_fail_closed"


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


class TestFormatIssueDateDe:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("2024-11-24", "November 2024"),
            ("2024-01-01", "Januar 2024"),
            ("2023-12-31T15:30:00Z", "Dezember 2023"),  # ISO timestamp tail is sliced off
            (None, None),
            ("", None),
            ("not-a-date", None),
        ],
    )
    def test_renders_german_month(self, raw, expected):
        assert _format_issue_date_de(raw) == expected


class TestSynthesizeAiTitle:
    def _ex(self, **overrides) -> DocumentExtraction:
        defaults = dict(
            document_type=DocumentType.Gehaltsabrechnung,
            correspondent="Acme GmbH",
            key_dates=KeyDates(issue="2024-11-24"),
            summary_de="Satz eins. Satz zwei. Satz drei.",
            confidence=0.9,
        )
        defaults.update(overrides)
        return DocumentExtraction(**defaults)

    def test_full_title(self):
        assert _synthesize_ai_title(self._ex()) == "Gehaltsabrechnung · Acme GmbH · November 2024"

    def test_drops_missing_correspondent(self):
        assert (
            _synthesize_ai_title(self._ex(correspondent=None))
            == "Gehaltsabrechnung · November 2024"
        )

    def test_drops_missing_date(self):
        assert (
            _synthesize_ai_title(self._ex(key_dates=KeyDates())) == "Gehaltsabrechnung · Acme GmbH"
        )

    def test_doc_type_only_when_everything_else_missing(self):
        ex = self._ex(correspondent=None, key_dates=KeyDates())
        assert _synthesize_ai_title(ex) == "Gehaltsabrechnung"

    def test_strips_correspondent_whitespace(self):
        ex = self._ex(correspondent="  Acme GmbH  ")
        assert "Acme GmbH" in _synthesize_ai_title(ex)


class TestSynthesizeSuggestedTags:
    def test_type_always_included(self):
        ex = DocumentExtraction(document_type=DocumentType.Rechnung)
        assert "Rechnung" in _synthesize_suggested_tags(ex)

    def test_year_added_when_issue_date_present(self):
        ex = DocumentExtraction(
            document_type=DocumentType.Vertrag,
            key_dates=KeyDates(issue="2024-03-15"),
        )
        tags = _synthesize_suggested_tags(ex)
        assert "Vertrag" in tags
        assert "2024" in tags

    def test_no_year_when_no_issue_date(self):
        ex = DocumentExtraction(document_type=DocumentType.Sonstiges)
        tags = _synthesize_suggested_tags(ex)
        assert tags == ["Sonstiges"]

    def test_never_empty(self):
        ex = DocumentExtraction(document_type=DocumentType.Sonstiges)
        assert len(_synthesize_suggested_tags(ex)) >= 1


class TestTruncateText:
    def test_short_text_unchanged(self):
        assert _truncate_text("hello", max_tokens=100) == "hello"

    def test_long_text_truncated_with_notice(self):
        text = "a" * 5000
        result = _truncate_text(text, max_tokens=100)  # 100 * 4 = 400 chars
        assert len(result) == 400 + len("\n\n[Dokument wurde aufgrund der Länge gekürzt.]")
        assert "gekürzt" in result


class TestFallbackConfidenceReason:
    """The few-shot examples MUST emit a concrete confidence_reason — small
    models imitate shape, so a null in the example trains the model to drop
    the field. Cover all three tiers."""

    def test_high_confidence_tier(self):
        msg = _fallback_confidence_reason(0.95)
        assert "Briefkopf" in msg
        assert "eindeutig" in msg

    def test_high_confidence_boundary(self):
        # 0.85 is exactly on the high-tier threshold.
        assert "Briefkopf" in _fallback_confidence_reason(0.85)

    def test_mid_confidence_tier(self):
        msg = _fallback_confidence_reason(0.7)
        assert "Korrespondent" in msg

    def test_mid_confidence_boundary(self):
        assert "Korrespondent" in _fallback_confidence_reason(0.6)

    def test_low_confidence_tier(self):
        msg = _fallback_confidence_reason(0.3)
        assert "OCR" in msg or "fragment" in msg.lower()

    def test_low_confidence_zero(self):
        msg = _fallback_confidence_reason(0.0)
        assert msg  # non-empty
        assert "OCR" in msg or "fragment" in msg.lower()


class TestExamplePayloadCarriesConfidenceReason:
    """The whole point of putting confidence_reason in the few-shot payload —
    if a doc has the field stored, surface it; otherwise fall back to the
    tier-appropriate sentence. Either way the rendered JSON contains the key."""

    def test_uses_stored_reason_when_present(self):
        out = _example_payload(
            {
                "ai_document_type": "Rechnung",
                "ai_confidence": 0.92,
                "ai_confidence_reason": "Klarer Briefkopf der Stadtwerke; Beträge eindeutig.",
            },
            correspondent_name=None,
            document_type_name=None,
            created_date=None,
            tag_names=[],
        )
        assert "confidence_reason" in out
        assert "Stadtwerke" in out

    def test_falls_back_to_tier_sentence_when_reason_missing(self):
        out = _example_payload(
            {"ai_document_type": "Rechnung", "ai_confidence": 0.95},
            correspondent_name=None,
            document_type_name=None,
            created_date=None,
            tag_names=[],
        )
        assert "confidence_reason" in out
        assert "Briefkopf" in out  # high-tier fallback


class TestFormatError:
    def test_basic_shape(self):
        exc = RuntimeError("Ollama returned 500")
        out = _format_error("LLM-Extraktion fehlgeschlagen", exc)
        assert out == "LLM-Extraktion fehlgeschlagen – RuntimeError: Ollama returned 500"

    def test_empty_message_falls_back_to_repr(self):
        exc = ValueError()
        out = _format_error("X", exc)
        # repr(ValueError()) is "ValueError()" — guarantees something non-empty.
        assert "ValueError" in out
        assert out.startswith("X – ValueError: ")

    def test_caps_around_2000_chars(self):
        # The cap is "anything over 2000 → keep 1997 chars + ellipsis", so the
        # final length is 1998 — well under the Paperless longtext column
        # limit but stable across runs.
        exc = RuntimeError("x" * 5000)
        out = _format_error("Label", exc)
        assert len(out) == 1998
        assert out.endswith("…")
