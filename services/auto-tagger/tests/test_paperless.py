import pytest

from auto_tagger.paperless import (
    LIFECYCLE_TAGS,
    _normalize_monetary,
    _truncate_string_field,
)


class TestNormalizeMonetary:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("149,99 EUR", "EUR149.99"),
            ("EUR 149,99", "EUR149.99"),
            ("EUR149.99", "EUR149.99"),
            ("1.234,56 EUR", "EUR1234.56"),
            ("USD 1,234.56", "USD1234.56"),
            ("149.99 USD", "USD149.99"),
            ("€149,99", "EUR149.99"),
            ("$149.99", "USD149.99"),
            ("£149.99", "GBP149.99"),
            ("0,00 EUR", "EUR0.00"),
            ("-50,00 EUR", "EUR-50.00"),
            ("12,5 EUR", "EUR12.50"),
        ],
    )
    def test_normalises_to_paperless_format(self, value, expected):
        assert _normalize_monetary(value) == expected

    @pytest.mark.parametrize("value", [None, "", "   ", "Beträge variieren", "abc", "EUR"])
    def test_returns_none_when_unparseable(self, value):
        assert _normalize_monetary(value) is None

    def test_defaults_to_eur_when_no_currency_marker(self):
        # No code, no symbol — caller is German DMS, EUR is the safe default.
        assert _normalize_monetary("149,99") == "EUR149.99"


class TestTruncateStringField:
    def test_none_passes_through(self):
        assert _truncate_string_field(None) is None

    def test_short_string_unchanged(self):
        assert _truncate_string_field("hello") == "hello"

    def test_empty_string_unchanged(self):
        assert _truncate_string_field("") == ""

    def test_exactly_at_limit_unchanged(self):
        s = "x" * 128
        result = _truncate_string_field(s)
        assert result == s
        assert len(result) == 128

    def test_one_char_over_limit_truncated(self):
        s = "x" * 129
        result = _truncate_string_field(s)
        assert len(result) == 128
        assert result.endswith("…")

    def test_long_string_truncated_with_ellipsis(self):
        s = "x" * 500
        result = _truncate_string_field(s)
        assert len(result) == 128
        assert result.endswith("…")
        assert result[:-1] == "x" * 127


class TestLifecycleTags:
    def test_contains_six_states(self):
        assert len(LIFECYCLE_TAGS) == 6

    def test_includes_all_pipeline_states(self):
        expected = {
            "ai-pending",
            "ai-approved",
            "ai-rejected",
            "ai-propagated",
            "ai-propagation-error",
            "ai-error",
        }
        assert set(LIFECYCLE_TAGS) == expected
