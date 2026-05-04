"""Unit tests for the RAG backfill (Phase 1.6).

Stubs PaperlessClient, embedder, and vector store, then asserts the
backfill loop dispatches the right calls and emits the expected
JSON-line events. The actual indexing path (chunk → embed → upsert)
is exercised end-to-end via `index_document` so this file focuses on
the orchestration: paginate the listing, skip already-indexed docs,
account for indexed/skipped/failed correctly, and emit one event per
outcome with the documented schema.
"""

from __future__ import annotations

import io
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from auto_tagger.backfill import (
    BackfillReport,
    backfill_index,
    iterate_propagated_doc_ids,
)
from auto_tagger.indexer import IndexingDeps


def _events(buf: io.StringIO) -> list[dict]:
    """Parse the captured JSON-line stream into dicts."""
    return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def _paperless_with_pages(pages: list[dict[str, Any]]) -> AsyncMock:
    """Stub a PaperlessClient whose `_get_tag_id` and `_client.get`
    serve a sequence of paginated `/api/documents/` responses.

    Each entry in `pages` is one page payload as returned by Paperless:
    `{"results": [...], "next": "<url>"|None}`.
    """
    paperless = AsyncMock()
    paperless._get_tag_id = AsyncMock(return_value=1)

    response_iter = iter(pages)

    class _StubResp:
        def __init__(self, body: dict) -> None:
            self._body = body

        def raise_for_status(self) -> None:
            return

        def json(self) -> dict:
            return self._body

    async def _get(url: str, params: dict | None = None) -> _StubResp:
        return _StubResp(next(response_iter))

    inner = MagicMock()
    inner.get = AsyncMock(side_effect=_get)
    paperless._client = inner

    return paperless


def _make_deps(
    *,
    paperless: AsyncMock,
    chunk_counts: dict[int, int] | None = None,
    indexer_writes: dict[int, int] | None = None,
    raise_on_index: dict[int, Exception] | None = None,
) -> IndexingDeps:
    """Build IndexingDeps with stub vector store and embedder.

    `chunk_counts` is the count returned by `count_chunks_for_doc` for
    each doc id BEFORE backfill runs (controls the skip path).
    `indexer_writes` is the count to return AFTER `index_document`
    runs (controls success/failure detection — the backfill counts a
    second time post-index).
    """
    chunk_counts = chunk_counts or {}
    indexer_writes = indexer_writes or {}
    raise_on_index = raise_on_index or {}

    # Two-stage count behaviour: returns chunk_counts on the first call
    # per doc (skip check), indexer_writes on the second call (post-
    # index landing check).
    seen: dict[int, int] = {}

    async def _count(doc_id: int) -> int:
        seen[doc_id] = seen.get(doc_id, 0) + 1
        if seen[doc_id] == 1:
            return chunk_counts.get(doc_id, 0)
        return indexer_writes.get(doc_id, 0)

    vector_store = MagicMock()
    vector_store.count_chunks_for_doc = AsyncMock(side_effect=_count)
    vector_store.delete_by_doc_id = AsyncMock()
    vector_store.upsert_chunks = AsyncMock()
    vector_store.ensure_collection = AsyncMock()

    embedder = MagicMock()
    embedder.embed_dense = AsyncMock(return_value=[])
    embedder.dense_dim = 1024
    embedder.model = "bge-m3"

    deps = IndexingDeps(
        paperless=paperless, embedder=embedder, vector_store=vector_store
    )

    # Replace `index_document` indirectly by stubbing the paperless
    # methods it consumes. For backfill tests we don't need the real
    # indexer to run — we only care that the orchestration counts
    # outcomes correctly. Make `get_document` raise/succeed per the
    # raise_on_index map; the backfill catches and reports.
    async def _get_document(doc_id: int) -> dict:
        if doc_id in raise_on_index:
            raise raise_on_index[doc_id]
        return {
            "id": doc_id,
            "content": "kurzer Inhalt",
            "tags": [],
            "correspondent": None,
            "document_type": None,
            "created_date": None,
        }

    paperless.get_document = AsyncMock(side_effect=_get_document)
    paperless.get_document_content = AsyncMock(return_value="kurzer Inhalt")
    paperless.get_entity_name_map = AsyncMock(return_value={})
    paperless.get_ai_custom_field_values = AsyncMock(return_value={})
    paperless._get_tag_id = paperless._get_tag_id  # keep the existing one
    paperless.get_or_create_tag = AsyncMock(return_value=999)
    paperless.patch_document_native_fields = AsyncMock()

    return deps


# ---- iterate_propagated_doc_ids -------------------------------------------


async def test_iterate_returns_empty_when_tag_missing():
    """If `ai-propagated` doesn't exist yet (fresh install with no
    propagated docs), the iterator yields nothing."""
    paperless = AsyncMock()
    paperless._get_tag_id = AsyncMock(return_value=None)

    out = [doc_id async for doc_id in iterate_propagated_doc_ids(paperless)]

    assert out == []


async def test_iterate_paginates_across_pages():
    """Iterator yields every doc id across multi-page Paperless responses."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 1}, {"id": 2}], "next": "/api/documents/?page=2"},
            {"results": [{"id": 3}, {"id": 4}], "next": "/api/documents/?page=3"},
            {"results": [{"id": 5}], "next": None},
        ]
    )

    out = [doc_id async for doc_id in iterate_propagated_doc_ids(paperless)]

    assert out == [1, 2, 3, 4, 5]


async def test_iterate_stops_at_first_page_without_next():
    """Single-page result → one fetch, then done."""
    paperless = _paperless_with_pages(
        [{"results": [{"id": 1}, {"id": 2}], "next": None}]
    )

    out = [doc_id async for doc_id in iterate_propagated_doc_ids(paperless)]

    assert out == [1, 2]


# ---- backfill_index orchestration ----------------------------------------


async def test_backfill_skips_already_indexed_docs():
    """Docs with existing chunks in Qdrant are skipped without re-indexing."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 10}, {"id": 20}], "next": None},
            # backfill_index does TWO listing scans (count, then work)
            {"results": [{"id": 10}, {"id": 20}], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={10: 5, 20: 0},  # 10 already indexed; 20 needs work
        indexer_writes={20: 3},
    )

    buf = io.StringIO()
    report = await backfill_index(deps, out=buf)

    assert isinstance(report, BackfillReport)
    assert report.skipped == 1
    assert report.indexed == 1
    assert report.failed == 0

    events = _events(buf)
    assert events[0] == {"event": "started", "total": 2}
    skipped = next(e for e in events if e["event"] == "doc_skipped")
    assert skipped["doc_id"] == 10
    assert skipped["chunks"] == 5
    indexed = next(e for e in events if e["event"] == "doc_indexed")
    assert indexed["doc_id"] == 20
    assert indexed["chunks"] == 3
    assert events[-1] == {
        "event": "completed",
        "indexed": 1,
        "skipped": 1,
        "failed": 0,
    }


async def test_backfill_force_reindexes_already_indexed():
    """`force=True` ignores existing chunks and re-runs the indexer."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 10}], "next": None},
            {"results": [{"id": 10}], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={10: 5},
        indexer_writes={10: 3},
    )

    buf = io.StringIO()
    report = await backfill_index(deps, force=True, out=buf)

    assert report.skipped == 0
    assert report.indexed == 1
    events = _events(buf)
    indexed = next(e for e in events if e["event"] == "doc_indexed")
    assert indexed["doc_id"] == 10


async def test_backfill_records_failure_when_index_produces_no_chunks():
    """Indexer ran but Qdrant ended up with zero chunks (empty content,
    embedding error, etc.) — counts as a failure with a clear reason."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 10}], "next": None},
            {"results": [{"id": 10}], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={10: 0},
        indexer_writes={10: 0},  # indexer ran, nothing landed
    )

    buf = io.StringIO()
    report = await backfill_index(deps, out=buf)

    assert report.failed == 1
    assert report.indexed == 0
    failed = next(e for e in _events(buf) if e["event"] == "doc_failed")
    assert failed["doc_id"] == 10
    assert "zero chunks" in failed["error"]


async def test_backfill_continues_past_per_doc_exception():
    """A doc whose fetch blows up (Paperless cache miss, transient 5xx)
    is recorded as failed — the rest of the corpus still gets indexed."""
    paperless = _paperless_with_pages(
        [
            {
                "results": [{"id": 10}, {"id": 20}, {"id": 30}],
                "next": None,
            },
            {
                "results": [{"id": 10}, {"id": 20}, {"id": 30}],
                "next": None,
            },
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={10: 0, 20: 0, 30: 0},
        indexer_writes={10: 1, 30: 1},
        # 20 fetched-side raises; the indexer's get_document is the
        # one inside our IndexingDeps stub, so we route the failure
        # through the count side instead by raising on the second call.
    )

    # Wire the failure differently: `count_chunks_for_doc` for doc 20
    # raises mid-run, simulating a Qdrant blip on the second count.
    original = deps.vector_store.count_chunks_for_doc.side_effect

    seen: dict[int, int] = {}

    async def _count_with_blip(doc_id: int) -> int:
        seen[doc_id] = seen.get(doc_id, 0) + 1
        if doc_id == 20 and seen[doc_id] == 1:
            raise RuntimeError("qdrant transient")
        return await original(doc_id)

    deps.vector_store.count_chunks_for_doc.side_effect = _count_with_blip

    buf = io.StringIO()
    report = await backfill_index(deps, out=buf)

    # Two docs successfully indexed, one failed.
    assert report.indexed == 2
    assert report.failed == 1


async def test_backfill_emits_started_with_total_count():
    """Every run emits exactly one `started` event carrying the total
    so a desktop shell progress bar can render at the right scale."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": i} for i in range(7)], "next": None},
            {"results": [{"id": i} for i in range(7)], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={i: 1 for i in range(7)},  # all already-indexed
    )

    buf = io.StringIO()
    await backfill_index(deps, out=buf)

    events = _events(buf)
    started = [e for e in events if e["event"] == "started"]
    assert len(started) == 1
    assert started[0]["total"] == 7


async def test_backfill_empty_corpus_completes_cleanly():
    """Fresh install with zero propagated docs: emits started(total=0)
    and completed(0,0,0) without errors."""
    paperless = AsyncMock()
    paperless._get_tag_id = AsyncMock(return_value=None)
    deps = _make_deps(paperless=paperless)

    buf = io.StringIO()
    report = await backfill_index(deps, out=buf)

    assert report == BackfillReport(indexed=0, skipped=0, failed=0)
    events = _events(buf)
    assert events == [
        {"event": "started", "total": 0},
        {"event": "completed", "indexed": 0, "skipped": 0, "failed": 0},
    ]


# ---- output-stream contract -----------------------------------------------


async def test_each_event_is_one_json_line():
    """The desktop shell parses stdout one line at a time; every event
    must be valid JSON on its own line. Partial / multi-line events
    would deadlock the consumer."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 1}], "next": None},
            {"results": [{"id": 1}], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={1: 0},
        indexer_writes={1: 1},
    )

    buf = io.StringIO()
    await backfill_index(deps, out=buf)

    for line in buf.getvalue().splitlines():
        assert line.strip(), "no blank lines allowed in the event stream"
        # Must round-trip cleanly; raises on malformed JSON.
        parsed = json.loads(line)
        assert "event" in parsed


@pytest.mark.parametrize(
    "force,expected_indexed",
    [(False, 0), (True, 1)],
)
async def test_force_flag_controls_skip_behavior(force: bool, expected_indexed: int):
    """`force=False` skips existing chunks (default — fast no-op);
    `force=True` re-indexes regardless. Pinning both branches so a
    refactor can't silently flip the default."""
    paperless = _paperless_with_pages(
        [
            {"results": [{"id": 1}], "next": None},
            {"results": [{"id": 1}], "next": None},
        ]
    )
    deps = _make_deps(
        paperless=paperless,
        chunk_counts={1: 5},
        indexer_writes={1: 3},
    )

    buf = io.StringIO()
    report = await backfill_index(deps, force=force, out=buf)

    assert report.indexed == expected_indexed
