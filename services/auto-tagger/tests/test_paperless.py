import httpx
import pytest
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient
from aktenraum_core.paperless.normalisers import (
    LONGTEXT_FIELDS,
    _normalize_date,
    _normalize_monetary,
    _truncate_string_field,
    truncate_for_field,
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


class TestTruncateForField:
    """truncate_for_field is what the AI write paths actually call. It applies
    the 128-char clip to `string` Paperless fields and skips longtext fields
    so multi-sentence summaries survive intact.
    """

    def test_longtext_field_is_not_truncated(self):
        long_summary = (
            "Bei dem vorliegenden Dokument handelt es sich um eine "
            "Teilnahmebescheinigung. " * 8
        )
        assert len(long_summary) > 128
        assert truncate_for_field("ai_summary_de", long_summary) == long_summary

    def test_string_field_still_gets_truncated(self):
        long = "x" * 200
        out = truncate_for_field("ai_correspondent", long)
        assert len(out) == 128
        assert out.endswith("…")

    def test_longtext_set_is_explicit(self):
        # The set is intentionally tiny — adding a longtext field requires a
        # paired bootstrap-script change, so we want the test to flinch when
        # someone widens the set without thinking.
        assert LONGTEXT_FIELDS == {"ai_summary_de", "ai_error_message"}

    def test_none_passthrough_for_both_kinds(self):
        assert truncate_for_field("ai_summary_de", None) is None
        assert truncate_for_field("ai_correspondent", None) is None


class TestNormalizeDate:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("2024-12-01", "2024-12-01"),  # already canonical
            ("01.12.2024", "2024-12-01"),  # German full
            ("01/12/2024", "2024-12-01"),  # European slash
            ("2024/12/01", "2024-12-01"),  # ISO with slashes
            ("01.12.24", "2024-12-01"),  # German short year
            ("12.2024", "2024-12-01"),  # German month-year → anchor to day 1
            ("12/2024", "2024-12-01"),
            ("2024-12", "2024-12-01"),  # ISO month-year
            ("  2024-12-01  ", "2024-12-01"),  # trim whitespace
        ],
    )
    def test_normalises_to_iso(self, value, expected):
        assert _normalize_date(value) == expected

    @pytest.mark.parametrize(
        "value", [None, "", "   ", "December 2024", "Dezember 2024", "abc", "13/13/2024"]
    )
    def test_returns_none_when_unparseable(self, value):
        assert _normalize_date(value) is None


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


def _client_with_transport(handler):
    transport = httpx.MockTransport(handler)
    client = PaperlessClient(base_url="http://paperless.test", api_token="tok")
    # Swap the live httpx.AsyncClient for one bound to the mock transport so the
    # tests stay pure-function with no real network.
    client._client = httpx.AsyncClient(
        base_url="http://paperless.test",
        transport=transport,
        timeout=5.0,
    )
    return client


_CUSTOM_FIELDS_PAGE = {
    "results": [
        {"id": 1, "name": "ai_document_type"},
        {"id": 2, "name": "ai_correspondent"},
        {"id": 15, "name": "ai_title"},
        {"id": 99, "name": "ai_error_message"},
    ]
}


class TestSetErrorMessage:
    @pytest.mark.asyncio
    async def test_writes_message_and_preserves_existing_fields(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/custom_fields/":
                return httpx.Response(200, json=_CUSTOM_FIELDS_PAGE)
            if (
                request.method == "GET"
                and request.url.path == "/api/documents/42/"
            ):
                return httpx.Response(
                    200,
                    json={
                        "id": 42,
                        "custom_fields": [
                            {"field": 1, "value": "Rechnung"},
                            {"field": 2, "value": "Stadtwerke"},
                            # No prior error message — fresh failure.
                        ],
                    },
                )
            if (
                request.method == "PATCH"
                and request.url.path == "/api/documents/42/"
            ):
                captured["body"] = request.read()
                return httpx.Response(200, json={})
            return httpx.Response(404)

        client = _client_with_transport(handler)
        try:
            await client.set_error_message(42, "Boom")
        finally:
            await client.aclose()

        body = captured["body"].decode()
        assert '"field":99' in body.replace(" ", "")
        assert '"value":"Boom"' in body.replace(" ", "")
        # Existing fields must survive the merge.
        assert '"value":"Rechnung"' in body.replace(" ", "")
        assert '"value":"Stadtwerke"' in body.replace(" ", "")

    @pytest.mark.asyncio
    async def test_clears_existing_message_when_none_passed(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/custom_fields/":
                return httpx.Response(200, json=_CUSTOM_FIELDS_PAGE)
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "id": 42,
                        "custom_fields": [
                            {"field": 1, "value": "Rechnung"},
                            {"field": 99, "value": "prior failure"},
                        ],
                    },
                )
            if request.method == "PATCH":
                captured["body"] = request.read()
                return httpx.Response(200, json={})
            return httpx.Response(404)

        client = _client_with_transport(handler)
        try:
            await client.set_error_message(42, None)
        finally:
            await client.aclose()

        body = captured["body"].decode().replace(" ", "")
        # ai_error_message is dropped, other fields stay.
        assert '"field":99' not in body
        assert '"value":"Rechnung"' in body

    @pytest.mark.asyncio
    async def test_silently_skips_when_field_not_bootstrapped(self):
        """Older installs that haven't re-run bootstrap-paperless.sh don't have
        ai_error_message yet; the writer must log + skip without raising."""

        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.method + " " + request.url.path)
            if request.url.path == "/api/custom_fields/":
                # Field map without ai_error_message.
                return httpx.Response(
                    200,
                    json={"results": [{"id": 1, "name": "ai_document_type"}]},
                )
            return httpx.Response(500)  # would fail the assertion below if hit

        client = _client_with_transport(handler)
        try:
            # Must not raise; no document GET / PATCH should occur.
            await client.set_error_message(42, "Boom")
        finally:
            await client.aclose()

        assert seen == ["GET /api/custom_fields/"]

    @pytest.mark.asyncio
    async def test_swallows_paperless_4xx_so_caller_failure_path_continues(self):
        """The writer is best-effort — the caller is already handling a primary
        failure; we must never raise and mask it."""

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/custom_fields/":
                return httpx.Response(200, json=_CUSTOM_FIELDS_PAGE)
            if request.method == "GET":
                return httpx.Response(
                    200, json={"id": 42, "custom_fields": []}
                )
            # PATCH rejected — must NOT raise.
            return httpx.Response(400, text="bad request")

        client = _client_with_transport(handler)
        try:
            await client.set_error_message(42, "Boom")
        finally:
            await client.aclose()
