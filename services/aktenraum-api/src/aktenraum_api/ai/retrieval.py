"""Hybrid query-time retrieval (RAG Phase 1.8).

Composes the four primitives shipped earlier in Phase 1 into a single
coherent path:

    embed query (bge-m3 via Ollama)
        ↓
    Qdrant search top-K with payload filter (doc_type / correspondent
    / tags / doc_ids derived from the SearchFilter the LLM emitted)
        ↓
    rerank (bge-reranker-v2-m3 cross-encoder, top-K → top-N)
        ↓
    return RetrievedChunk[] sorted by reranker score, descending

The result is what the answer LLM gets as context (1.9 wires the
prompt). For now this module exposes a single coroutine
`retrieve_chunks_for_question` plus the typed input/output dataclasses.

Resilience: if any stage of the pipeline raises, the function returns
an empty list with a warning log rather than blowing up the whole
/ask request — degrading to "no chunks found" so the answer endpoint
can fall back to its existing AI-metadata-only path. Never let RAG
errors take down a request that could have served a soft-fail.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import structlog
from aktenraum_core.rag import (
    ChunkPayload,
    Embedder,
    QdrantVectorStore,
    RerankCandidate,
    Reranker,
)
from aktenraum_core.rag import (
    SearchFilter as VectorSearchFilter,
)

from .schemas import SearchFilter

log = structlog.get_logger()


@dataclass(frozen=True)
class RetrievedChunk:
    """One chunk surfaced by hybrid retrieval, ordered by reranker score.

    Carries everything the answer prompt needs to cite the source: the
    doc id, the chunk text itself, and the doc-level metadata
    (doc_type, correspondent, dates) the chunker denormalised into
    Qdrant payload at index time.
    """

    doc_id: int
    chunk_index: int
    text: str
    score: float
    doc_type: str | None = None
    correspondent: str | None = None
    tags: tuple[str, ...] = ()
    created_date: date | None = None
    page: int | None = None


@dataclass(frozen=True)
class RetrievalDeps:
    """Bag of collaborators used by `retrieve_chunks_for_question`.

    Constructed once per FastAPI request (or pinned to app.state for
    process-wide reuse — both work, the wrapper is stateless beyond
    its underlying clients). Keeping this as a dataclass rather than
    positional args makes the unit tests almost trivially mockable.
    """

    embedder: Embedder
    vector_store: QdrantVectorStore
    reranker: Reranker


async def retrieve_chunks_for_question(
    question: str,
    *,
    deps: RetrievalDeps,
    structural_filter: SearchFilter | None = None,
    fetch_top_k: int = 50,
    rerank_top_k: int = 5,
) -> list[RetrievedChunk]:
    """Run the full hybrid retrieval pipeline and return ranked chunks.

    `structural_filter` narrows the dense search at the Qdrant payload
    layer — same filter shape the existing `/api/ai/find` and
    `/api/ai/answer` endpoints already produce, so the RAG path
    inherits all the doc-type / correspondent / tag / date hints the
    filter LLM extracts.

    `fetch_top_k` is the wide first stage (dense recall). `rerank_top_k`
    is the narrow output. `fetch_top_k` should be ~10× `rerank_top_k`
    so the cross-encoder has enough candidates to pick the best from.

    Empty question or empty store → empty result with no upstream
    calls. Any per-stage error is logged and surfaces as an empty
    result; the calling endpoint should treat empty == no relevant
    chunks and decide whether to fall back to its structural-only
    answer path.
    """
    if not question.strip():
        return []
    try:
        embeddings = await deps.embedder.embed_dense([question])
    except Exception as exc:
        log.warning("rag_retrieve_embed_failed", error=str(exc))
        return []
    if not embeddings:
        return []
    query_vec = embeddings[0]

    qfilter = (
        _to_vector_filter(structural_filter)
        if structural_filter is not None
        else None
    )
    try:
        hits = await deps.vector_store.search(
            query_vector=query_vec,
            top_k=fetch_top_k,
            filter=qfilter,
        )
    except Exception as exc:
        log.warning("rag_retrieve_qdrant_failed", error=str(exc))
        return []
    if not hits:
        return []

    candidates = [
        RerankCandidate(id=_chunk_key(hit.payload), text=hit.payload.text)
        for hit in hits
    ]
    try:
        ranked = await deps.reranker.rerank(
            question, candidates, top_k=rerank_top_k
        )
    except Exception as exc:
        log.warning("rag_retrieve_rerank_failed", error=str(exc))
        # Degrade gracefully: fall through to dense-only ordering. The
        # results aren't as good, but a working answer beats no answer.
        ranked = [
            type("R", (), {"id": c.id, "score": float(h.score)})()
            for c, h in zip(candidates[:rerank_top_k], hits[:rerank_top_k], strict=False)
        ]

    payload_by_key = {_chunk_key(h.payload): h.payload for h in hits}
    out: list[RetrievedChunk] = []
    for r in ranked:
        payload = payload_by_key.get(r.id)
        if payload is None:
            continue
        out.append(_payload_to_retrieved(payload, r.score))
    return out


def _to_vector_filter(f: SearchFilter) -> VectorSearchFilter:
    """Project an LLM-emitted SearchFilter onto the smaller shape the
    Qdrant payload filter understands. Only the closed-enum / list
    fields are used — date ranges and amount bounds aren't indexed
    on chunks (those filters apply post-fetch on the answer
    endpoint's existing path).
    """
    doc_types: list[str] = []
    if f.document_type is not None:
        doc_types.append(f.document_type.value)
    correspondents = [f.correspondent] if f.correspondent else []
    return VectorSearchFilter(
        doc_types=doc_types,
        correspondents=correspondents,
        tags=list(f.tags),
        doc_ids=[],
    )


def _chunk_key(payload: ChunkPayload) -> str:
    """Composite key the reranker uses to track which chunk is which.
    Mirrors the deterministic UUID5 the vector store uses for point
    ids — same shape so we don't reinvent two key schemes. We use a
    plain `doc_id:chunk_index` string here because the reranker has
    no Qdrant context."""
    return f"{payload.doc_id}:{payload.chunk_index}"


def _payload_to_retrieved(payload: ChunkPayload, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        doc_id=payload.doc_id,
        chunk_index=payload.chunk_index,
        text=payload.text,
        score=score,
        doc_type=payload.doc_type,
        correspondent=payload.correspondent,
        tags=tuple(payload.tags),
        created_date=payload.created_date,
        page=payload.page,
    )


__all__ = [
    "RetrievalDeps",
    "RetrievedChunk",
    "retrieve_chunks_for_question",
]
