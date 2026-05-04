"""Unit tests for the RAG hybrid-retrieval coordinator (Phase 1.8).

Stubs each of the three collaborators (embedder / vector store /
reranker) and asserts the orchestration:

  - empty / whitespace question → empty result with no upstream calls
  - LLM-emitted SearchFilter → projected onto the Qdrant payload filter
  - reranker reorders the dense hits, payload re-attached for output
  - per-stage failure (embedder / qdrant / reranker) degrades gracefully
"""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock, MagicMock

from aktenraum_core.models import DocumentType
from aktenraum_core.rag import ChunkPayload, SearchHit

from aktenraum_api.ai.retrieval import (
    RetrievalDeps,
    RetrievedChunk,
    retrieve_chunks_for_question,
)
from aktenraum_api.ai.schemas import SearchFilter


def _payload(doc_id: int, idx: int = 0, text: str = "chunk text") -> ChunkPayload:
    return ChunkPayload(
        doc_id=doc_id,
        chunk_index=idx,
        text=text,
        char_start=0,
        char_end=len(text),
        token_count=len(text.split()),
        doc_type="Lebenslauf",
        correspondent="Selbst",
        tags=("Lebenslauf",),
        created_date=date(2024, 1, 15),
    )


def _hit(doc_id: int, *, idx: int = 0, score: float = 0.8, text: str = "chunk") -> SearchHit:
    return SearchHit(score=score, payload=_payload(doc_id, idx, text))


def _make_deps(
    *,
    embed_response: list[list[float]] | Exception | None = None,
    search_response: list[SearchHit] | Exception | None = None,
    rerank_response: list | Exception | None = None,
) -> RetrievalDeps:
    """Build deps with three stub collaborators recording calls."""
    embedder = MagicMock()
    if isinstance(embed_response, Exception):
        embedder.embed_dense = AsyncMock(side_effect=embed_response)
    else:
        embedder.embed_dense = AsyncMock(
            return_value=embed_response if embed_response is not None else [[0.1] * 1024]
        )
    embedder.dense_dim = 1024
    embedder.model = "bge-m3"

    vector_store = MagicMock()
    if isinstance(search_response, Exception):
        vector_store.search = AsyncMock(side_effect=search_response)
    else:
        vector_store.search = AsyncMock(
            return_value=search_response if search_response is not None else []
        )

    reranker = MagicMock()
    if isinstance(rerank_response, Exception):
        reranker.rerank = AsyncMock(side_effect=rerank_response)
    else:
        reranker.rerank = AsyncMock(
            return_value=rerank_response if rerank_response is not None else []
        )
    reranker.name = "sentence-transformers"
    reranker.model = "BAAI/bge-reranker-v2-m3"

    return RetrievalDeps(
        embedder=embedder, vector_store=vector_store, reranker=reranker
    )


class _RR:
    """Plain-attribute object mirroring RerankResult — used so tests
    can scripts reranker output without depending on the actual
    dataclass shape (which is enforced upstream by rerank_response)."""

    def __init__(self, id: str, score: float) -> None:
        self.id = id
        self.score = score


# ---- empty / degenerate inputs --------------------------------------------


async def test_empty_question_returns_empty_no_upstream():
    deps = _make_deps()
    out = await retrieve_chunks_for_question("", deps=deps)
    assert out == []
    deps.embedder.embed_dense.assert_not_awaited()
    deps.vector_store.search.assert_not_awaited()


async def test_whitespace_question_returns_empty():
    deps = _make_deps()
    out = await retrieve_chunks_for_question("   \n  ", deps=deps)
    assert out == []
    deps.embedder.embed_dense.assert_not_awaited()


async def test_no_qdrant_hits_returns_empty_no_rerank():
    """Qdrant returned nothing → skip the reranker call (saves a 600 MB
    model load on first use when the corpus is empty)."""
    deps = _make_deps(search_response=[])
    out = await retrieve_chunks_for_question("hello", deps=deps)
    assert out == []
    deps.reranker.rerank.assert_not_awaited()


# ---- happy path -----------------------------------------------------------


async def test_full_pipeline_returns_reranker_ordered_chunks():
    hits = [_hit(1, score=0.7), _hit(2, score=0.9), _hit(3, score=0.6)]
    deps = _make_deps(
        search_response=hits,
        rerank_response=[
            # Reranker reorders: doc 3 wins despite lower dense score.
            _RR(id="3:0", score=0.95),
            _RR(id="1:0", score=0.50),
            _RR(id="2:0", score=0.10),
        ],
    )

    out = await retrieve_chunks_for_question(
        "wie lange habe ich bei Kopfstand gearbeitet", deps=deps
    )

    assert [c.doc_id for c in out] == [3, 1, 2]
    assert out[0].score == 0.95
    # Payload metadata flows through.
    assert all(c.doc_type == "Lebenslauf" for c in out)


async def test_pipeline_passes_query_vec_to_qdrant():
    """The vector handed to Qdrant is the embedder's first row."""
    deps = _make_deps(
        embed_response=[[0.5] * 1024],
        search_response=[_hit(1)],
        rerank_response=[_RR(id="1:0", score=0.8)],
    )

    await retrieve_chunks_for_question("die frage", deps=deps)

    search_kwargs = deps.vector_store.search.await_args.kwargs
    assert search_kwargs["query_vector"] == [0.5] * 1024


async def test_pipeline_passes_top_k_through():
    deps = _make_deps(
        search_response=[_hit(i) for i in range(60)],
        rerank_response=[_RR(id=f"{i}:0", score=1.0 - i * 0.01) for i in range(60)],
    )

    await retrieve_chunks_for_question(
        "x", deps=deps, fetch_top_k=42, rerank_top_k=7
    )

    search_kwargs = deps.vector_store.search.await_args.kwargs
    assert search_kwargs["top_k"] == 42
    rerank_kwargs = deps.reranker.rerank.await_args.kwargs
    assert rerank_kwargs["top_k"] == 7


# ---- structural filter projection ----------------------------------------


async def test_search_filter_projects_to_qdrant_payload_filter():
    """LLM-emitted SearchFilter (document_type / correspondent / tags)
    becomes the Qdrant payload filter shape so the dense search itself
    is narrowed."""
    deps = _make_deps(
        search_response=[_hit(1)],
        rerank_response=[_RR(id="1:0", score=0.8)],
    )

    structural = SearchFilter(
        document_type=DocumentType.Lebenslauf
        if hasattr(DocumentType, "Lebenslauf")
        else DocumentType.Sonstiges,
        correspondent="Selbst",
        tags=["Lebenslauf"],
    )
    await retrieve_chunks_for_question(
        "x", deps=deps, structural_filter=structural
    )

    search_kwargs = deps.vector_store.search.await_args.kwargs
    qfilter = search_kwargs["filter"]
    assert qfilter is not None
    # Whatever doc_type was on the SearchFilter, it lands on the qdrant filter.
    assert structural.document_type.value in qfilter.doc_types
    assert "Selbst" in qfilter.correspondents
    assert "Lebenslauf" in qfilter.tags


async def test_no_structural_filter_passes_none_to_qdrant():
    deps = _make_deps(
        search_response=[_hit(1)],
        rerank_response=[_RR(id="1:0", score=0.8)],
    )

    await retrieve_chunks_for_question("x", deps=deps, structural_filter=None)

    search_kwargs = deps.vector_store.search.await_args.kwargs
    assert search_kwargs["filter"] is None


# ---- per-stage error handling --------------------------------------------


async def test_embedder_failure_returns_empty():
    deps = _make_deps(embed_response=RuntimeError("ollama unreachable"))

    out = await retrieve_chunks_for_question("hello", deps=deps)

    assert out == []
    deps.vector_store.search.assert_not_awaited()


async def test_qdrant_failure_returns_empty():
    deps = _make_deps(search_response=RuntimeError("qdrant down"))

    out = await retrieve_chunks_for_question("hello", deps=deps)

    assert out == []
    deps.reranker.rerank.assert_not_awaited()


async def test_reranker_failure_falls_back_to_dense_order():
    """When the reranker explodes (model load failure, OOM), we still
    return SOMETHING — dense-only ordering of the top-N. Worse quality
    than full rerank, but better than no answer."""
    hits = [
        _hit(1, score=0.9, text="a"),
        _hit(2, score=0.7, text="b"),
        _hit(3, score=0.5, text="c"),
    ]
    deps = _make_deps(
        search_response=hits,
        rerank_response=RuntimeError("model load failed"),
    )

    out = await retrieve_chunks_for_question(
        "hello", deps=deps, rerank_top_k=2
    )

    # Fell back to dense-ordered top-N.
    assert [c.doc_id for c in out] == [1, 2]


# ---- output shape --------------------------------------------------------


async def test_retrieved_chunk_dataclass_is_frozen():
    import pytest

    chunk = RetrievedChunk(doc_id=1, chunk_index=0, text="x", score=0.5)
    with pytest.raises(Exception):  # noqa: BLE001 — FrozenInstanceError
        chunk.score = 0.6  # type: ignore[misc]


async def test_unknown_rerank_id_dropped_silently():
    """If the reranker emits an id that doesn't match any retrieved
    chunk (impossible in practice, but defensive against future
    refactors), drop it rather than crash."""
    deps = _make_deps(
        search_response=[_hit(1)],
        rerank_response=[
            _RR(id="999:0", score=0.95),  # not in payload_by_key
            _RR(id="1:0", score=0.50),
        ],
    )

    out = await retrieve_chunks_for_question("x", deps=deps)

    assert [c.doc_id for c in out] == [1]
