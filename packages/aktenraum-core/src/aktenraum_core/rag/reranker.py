"""Cross-encoder reranker for the RAG retrieval pipeline (Phase 1.7).

After dense vector search returns top-K candidates by cosine similarity,
a cross-encoder reranker re-scores each (query, candidate) pair by
running them jointly through a transformer that has access to BOTH
sides of the comparison. This single step is the largest quality lever
in modern RAG — most "RAG sucks" complaints disappear once it lands.

Default model: `BAAI/bge-reranker-v2-m3`. Multilingual (German-strong),
~600 MB on disk, ~50 ms per pair on CPU. With top-50 candidates that
budgets to ~2.5s reranking — acceptable inside an answer pipeline that
already pays 5-30s for the LLM step. If latency becomes an issue, cap
candidates to 20 (1.0s) or swap to `bge-reranker-base` (~330 MB,
faster but slightly less accurate).

Why sentence-transformers and not Ollama: as of writing, Ollama does
not expose cross-encoder reranker models through a stable API.
sentence-transformers' `CrossEncoder` is the standard local-Python
path. The dependency is a soft import inside `LocalReranker.__init__`
so packages that don't construct a reranker don't pay the install
weight (auto-tagger never reranks; only aktenraum-api at query time).

The class accepts a `model` injection seam for testing — feed in any
object with a `predict(pairs) -> list[float]` method to exercise the
ranking logic without loading 600 MB of weights into a unit test.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import structlog

log = structlog.get_logger()


# Pinned default. Swappable at construction. Kept as a module constant
# so consumers reach for `DEFAULT_RERANKER_MODEL` rather than re-typing
# the model id at every call site.
DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"


@dataclass(frozen=True)
class RerankCandidate:
    """One candidate going into the reranker. The `id` is opaque to
    the reranker — a pure passthrough so the caller can stitch
    rerank scores back to whatever shape it stores candidates in
    (Qdrant SearchHit, search-result tuple, etc.)."""

    id: str
    text: str


@dataclass(frozen=True)
class RerankResult:
    """One reranked result. `score` is the raw cross-encoder logit; it
    is NOT a probability or normalized to [0, 1]. Callers should
    treat it as an ordering signal only — comparing scores across
    different reranker models is meaningless."""

    id: str
    score: float


@runtime_checkable
class Reranker(Protocol):
    """Pluggable reranker backend.

    `model` and `name` mirror the `Embedder` Protocol so observability
    code (logging, metrics, `/api/admin/index/status`) can treat all
    RAG components uniformly."""

    async def rerank(
        self,
        query: str,
        candidates: Sequence[RerankCandidate],
        *,
        top_k: int | None = None,
    ) -> list[RerankResult]: ...

    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...


class LocalReranker:
    """sentence-transformers `CrossEncoder` wrapped for our async API.

    `predict` is CPU-bound and synchronous; we offload it to a thread
    via `asyncio.to_thread` so the calling FastAPI handler doesn't
    block the event loop while the cross-encoder runs.

    Model is loaded lazily on the first `rerank` call — this matters
    for two reasons:
      1. Test environments can construct a `LocalReranker` without
         the 5-second model load on every test file.
      2. The 600 MB download from HuggingFace happens on first use
         rather than at process start, so the desktop shell can
         render a "downloading models" UI.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_RERANKER_MODEL,
        *,
        max_length: int = 512,
        model: Any | None = None,
    ) -> None:
        self._model_name = model_name
        self._max_length = max_length
        # Allow tests to inject a stub directly. In production this
        # is None at construction; the real `CrossEncoder` is loaded
        # in `_ensure_loaded` on first call.
        self._model = model
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "sentence-transformers"

    @property
    def model(self) -> str:
        return self._model_name

    async def _ensure_loaded(self) -> Any:
        """Lazy-load the cross-encoder. Behind a lock so two concurrent
        callers don't kick off two model loads."""
        if self._model is not None:
            return self._model
        async with self._lock:
            if self._model is not None:
                return self._model
            log.info("reranker_loading_model", model=self._model_name)
            # Soft import: callers that never construct a LocalReranker
            # don't pay the sentence-transformers install weight. Inside
            # a request path the import is cached after the first call.
            try:
                from sentence_transformers import CrossEncoder
            except ImportError as e:
                raise RuntimeError(
                    "LocalReranker requires the `sentence-transformers` "
                    "package. Install it via the consumer service's "
                    "dependencies (e.g. aktenraum-api), or swap to a "
                    "different Reranker implementation."
                ) from e
            self._model = await asyncio.to_thread(
                CrossEncoder, self._model_name, max_length=self._max_length
            )
            log.info("reranker_model_loaded", model=self._model_name)
            return self._model

    async def rerank(
        self,
        query: str,
        candidates: Sequence[RerankCandidate],
        *,
        top_k: int | None = None,
    ) -> list[RerankResult]:
        """Re-score every (query, candidate.text) pair, return them
        sorted by descending score. `top_k` truncates after sorting;
        passing None returns all candidates so the caller can decide.

        Empty candidates → empty result, no upstream call. This makes
        the function trivially callable in code paths where the
        retrieval step might return nothing.
        """
        if not candidates:
            return []
        model = await self._ensure_loaded()
        pairs = [(query, c.text) for c in candidates]
        # `predict` is sync + CPU-bound; bridge to the event loop.
        scores = await asyncio.to_thread(model.predict, pairs)
        ranked = [
            RerankResult(id=c.id, score=float(s))
            for c, s in zip(candidates, scores, strict=True)
        ]
        ranked.sort(key=lambda r: r.score, reverse=True)
        if top_k is not None:
            ranked = ranked[:top_k]
        return ranked
