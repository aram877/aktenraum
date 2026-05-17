from typing import Any
from unittest.mock import AsyncMock

import pytest

from auto_tagger.propagator import _split_suggested_tags, process_approved_document


class TestSplitSuggestedTags:
    def test_none_returns_empty(self):
        assert _split_suggested_tags(None) == []

    def test_empty_string_returns_empty(self):
        assert _split_suggested_tags("") == []

    def test_basic_csv(self):
        assert _split_suggested_tags("Vertrag, Industrie, Bauwesen") == [
            "Vertrag",
            "Industrie",
            "Bauwesen",
        ]

    def test_filters_lifecycle_tags(self):
        # The model could accidentally suggest a lifecycle tag — filtering
        # prevents it from triggering re-propagation or breaking state.
        result = _split_suggested_tags(
            "Vertrag, ai-approved, Industrie, ai-error, ai-pending"
        )
        assert "ai-approved" not in result
        assert "ai-error" not in result
        assert "ai-pending" not in result
        assert result == ["Vertrag", "Industrie"]

    def test_drops_truncation_artifacts(self):
        # 128-char string-field limit produces a trailing "…" via
        # _truncate_string_field; those tags are partial and worthless.
        assert _split_suggested_tags("Vertrag, Indus…") == ["Vertrag"]

    def test_strips_whitespace_and_skips_empty(self):
        assert _split_suggested_tags("  Vertrag  ,  ,  Industrie  ") == [
            "Vertrag",
            "Industrie",
        ]

    def test_preserves_non_lifecycle_tags_with_ai_prefix(self):
        # Only EXACT lifecycle names are filtered; "ai-something-else" passes.
        result = _split_suggested_tags("Vertrag, ai-custom, ai-pending")
        assert result == ["Vertrag", "ai-custom"]


# ---- duplicate detection integration (duplicate-flagging) ----


_AI_FIELD_IDS = {
    "ai_correspondent": 1,
    "ai_document_type": 2,
    "ai_issue_date": 3,
    "ai_monetary_amount": 4,
    "ai_reference_numbers": 5,
}
_AI_FIELD_NAME_BY_ID = {v: k for k, v in _AI_FIELD_IDS.items()}


def _candidate_doc(
    doc_id: int,
    *,
    correspondent: str | None = "Telekom",
    issue_date: str | None = "2024-03-15",
    monetary_amount: str | None = "EUR42.99",
    reference_numbers: str | None = None,
) -> dict[str, Any]:
    """Build the Paperless-shaped doc dict the dedup helper expects to
    project into a DocFields instance."""
    cf: list[dict[str, Any]] = []
    if correspondent is not None:
        cf.append(
            {"field": _AI_FIELD_IDS["ai_correspondent"], "value": correspondent}
        )
    if issue_date is not None:
        cf.append({"field": _AI_FIELD_IDS["ai_issue_date"], "value": issue_date})
    if monetary_amount is not None:
        cf.append(
            {
                "field": _AI_FIELD_IDS["ai_monetary_amount"],
                "value": monetary_amount,
            }
        )
    if reference_numbers is not None:
        cf.append(
            {
                "field": _AI_FIELD_IDS["ai_reference_numbers"],
                "value": reference_numbers,
            }
        )
    return {"id": doc_id, "custom_fields": cf, "tags": []}


def _make_paperless(
    *,
    new_doc_ai_fields: dict[str, str | None],
    candidate_docs: list[dict[str, Any]],
    add_tag_side_effect=None,
) -> AsyncMock:
    """Mock the slice of PaperlessClient that process_approved_document
    touches during propagation + dedup. Every method default is the
    minimum required for the happy path; tests override as needed."""
    p = AsyncMock()
    p.get_ai_custom_field_values = AsyncMock(return_value=new_doc_ai_fields)
    p.get_or_create_correspondent = AsyncMock(return_value=10)
    p.get_or_create_document_type = AsyncMock(return_value=20)

    # Tag-id resolver: stable ids per name so assertions can be specific.
    _tag_ids = {
        "ai-approved": 100,
        "ai-propagated": 101,
        "ai-duplicate": 102,
    }

    async def _get_tag_id(name: str) -> int | None:
        return _tag_ids.get(name)

    async def _get_or_create_tag(name: str) -> int:
        return _tag_ids.setdefault(name, 200 + len(_tag_ids))

    p._get_tag_id = AsyncMock(side_effect=_get_tag_id)
    p.get_or_create_tag = AsyncMock(side_effect=_get_or_create_tag)
    p.get_documents_with_tag = AsyncMock(return_value=candidate_docs)
    p.get_custom_field_name_by_id = AsyncMock(
        return_value=dict(_AI_FIELD_NAME_BY_ID)
    )
    p.patch_document_native_fields = AsyncMock()
    p.set_error_message = AsyncMock()
    p.add_tag_to_document = AsyncMock(side_effect=add_tag_side_effect)
    return p


def _ai_fields(
    *,
    correspondent: str = "Telekom",
    document_type: str = "Rechnung",
    issue_date: str = "2024-03-15",
    monetary_amount: str | None = "EUR42.99",
    reference_numbers: str | None = None,
) -> dict[str, str | None]:
    return {
        "ai_correspondent": correspondent,
        "ai_document_type": document_type,
        "ai_issue_date": issue_date,
        "ai_monetary_amount": monetary_amount,
        "ai_reference_numbers": reference_numbers,
    }


@pytest.mark.asyncio
async def test_propagator_tags_both_members_on_duplicate_match():
    """Happy path: a freshly-propagated doc matches an existing
    propagated candidate; both end up carrying ai-duplicate."""
    paperless = _make_paperless(
        new_doc_ai_fields=_ai_fields(),
        candidate_docs=[
            _candidate_doc(7, correspondent="Telekom", monetary_amount="EUR42.99")
        ],
    )
    new_doc = {"id": 99, "title": "New Telekom Rechnung", "tags": [100]}

    await process_approved_document(new_doc, paperless)

    # The new doc's lifecycle PATCH includes ai-duplicate alongside
    # ai-propagated (one PATCH, not two).
    paperless.patch_document_native_fields.assert_awaited_once()
    tags_arg = paperless.patch_document_native_fields.await_args.kwargs["tags"]
    assert 101 in tags_arg  # ai-propagated
    assert 102 in tags_arg  # ai-duplicate

    # The matched counterpart got an add_tag_to_document call.
    paperless.add_tag_to_document.assert_awaited_once_with(7, "ai-duplicate")


@pytest.mark.asyncio
async def test_propagator_skips_duplicate_check_without_correspondent():
    """Missing correspondent on the new doc → no dedup scan at all
    (no Paperless GET, no ai-duplicate tag in the PATCH)."""
    paperless = _make_paperless(
        new_doc_ai_fields=_ai_fields(correspondent=""),
        candidate_docs=[_candidate_doc(7)],
    )
    new_doc = {"id": 99, "title": "Doc", "tags": [100]}

    await process_approved_document(new_doc, paperless)

    paperless.get_documents_with_tag.assert_not_awaited()
    tags_arg = paperless.patch_document_native_fields.await_args.kwargs["tags"]
    assert 102 not in tags_arg


@pytest.mark.asyncio
async def test_propagator_swallows_matched_tag_patch_failure():
    """If add_tag_to_document raises for a matched id, the new doc's
    propagation still succeeds and a warning is logged. The new doc
    keeps ai-duplicate in its own tag set because that landed in the
    main PATCH."""
    paperless = _make_paperless(
        new_doc_ai_fields=_ai_fields(),
        candidate_docs=[_candidate_doc(7, monetary_amount="EUR42.99")],
        add_tag_side_effect=RuntimeError("paperless down"),
    )
    new_doc = {"id": 99, "title": "Doc", "tags": [100]}

    # Must not raise.
    await process_approved_document(new_doc, paperless)

    paperless.patch_document_native_fields.assert_awaited_once()
    tags_arg = paperless.patch_document_native_fields.await_args.kwargs["tags"]
    assert 102 in tags_arg
    # Matched-tag PATCH was attempted exactly once and threw.
    paperless.add_tag_to_document.assert_awaited_once()


@pytest.mark.asyncio
async def test_propagator_swallows_detection_lookup_failure():
    """If get_documents_with_tag itself raises, propagation still
    completes — the new doc lands as ai-propagated without ai-duplicate."""
    paperless = _make_paperless(
        new_doc_ai_fields=_ai_fields(),
        candidate_docs=[],
    )
    paperless.get_documents_with_tag = AsyncMock(
        side_effect=RuntimeError("paperless down")
    )
    new_doc = {"id": 99, "title": "Doc", "tags": [100]}

    await process_approved_document(new_doc, paperless)

    paperless.patch_document_native_fields.assert_awaited_once()
    tags_arg = paperless.patch_document_native_fields.await_args.kwargs["tags"]
    assert 101 in tags_arg
    assert 102 not in tags_arg


@pytest.mark.asyncio
async def test_propagator_no_duplicates_no_tag():
    """No matching candidates → ai-duplicate NOT added to the new doc."""
    paperless = _make_paperless(
        new_doc_ai_fields=_ai_fields(),
        candidate_docs=[
            _candidate_doc(7, correspondent="Vodafone")  # different correspondent
        ],
    )
    new_doc = {"id": 99, "title": "Doc", "tags": [100]}

    await process_approved_document(new_doc, paperless)

    tags_arg = paperless.patch_document_native_fields.await_args.kwargs["tags"]
    assert 102 not in tags_arg
    paperless.add_tag_to_document.assert_not_awaited()
