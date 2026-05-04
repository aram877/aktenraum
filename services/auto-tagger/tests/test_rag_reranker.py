"""Unit tests for the RAG reranker (Phase 1.7).

Stub the cross-encoder model directly via the constructor's `model=`
injection seam so tests don't load the real 600 MB bge-reranker
weights. The real `sentence_transformers.CrossEncoder` is only
exercised in the live integration path (1.8 onwards).
"""

from __future__ import annotations

import pytest
from aktenraum_core.rag import (
    DEFAULT_RERANKER_MODEL,
    LocalReranker,
    RerankCandidate,
    Reranker,
    RerankResult,
)


class _FakeCrossEncoder:
    """Stub of `sentence_transformers.CrossEncoder` exposing the only
    method the wrapper calls: `predict`. Returns scripted scores in
    the same order as the input pairs."""

    def __init__(self, scores: list[float]) -> None:
        self._scores = scores
        self.calls: list[list[tuple[str, str]]] = []

    def predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        self.calls.append(list(pairs))
        return self._scores[: len(pairs)]


def _candidates(texts: list[str]) -> list[RerankCandidate]:
    """Helper: build candidates whose ids mirror their order so test
    assertions can read at a glance."""
    return [RerankCandidate(id=str(i), text=t) for i, t in enumerate(texts)]


# ---- happy path ----------------------------------------------------------


async def test_rerank_orders_by_descending_score():
    """Cross-encoder returns higher score = more relevant. Wrapper
    sorts so the most-relevant candidate is first in the output."""
    fake = _FakeCrossEncoder(scores=[0.1, 0.9, 0.5])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank(
        "frage", _candidates(["wenig relevant", "sehr relevant", "mittel"])
    )

    assert [r.id for r in out] == ["1", "2", "0"]
    assert out[0].score == 0.9


async def test_rerank_top_k_truncates_after_sorting():
    """`top_k` cuts the result to the highest-scoring N — never to a
    pre-sort prefix."""
    fake = _FakeCrossEncoder(scores=[0.1, 0.9, 0.5, 0.3, 0.7])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank(
        "frage",
        _candidates(["a", "b", "c", "d", "e"]),
        top_k=2,
    )

    assert len(out) == 2
    assert [r.id for r in out] == ["1", "4"]  # 0.9 then 0.7


async def test_rerank_top_k_none_returns_all():
    fake = _FakeCrossEncoder(scores=[0.5, 0.5, 0.5])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank("q", _candidates(["a", "b", "c"]), top_k=None)
    assert len(out) == 3


async def test_rerank_top_k_larger_than_input_returns_all():
    fake = _FakeCrossEncoder(scores=[0.5])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank("q", _candidates(["only"]), top_k=99)
    assert len(out) == 1


# ---- empty input ---------------------------------------------------------


async def test_rerank_empty_candidates_short_circuits_without_model_call():
    """No upstream call when candidates is empty — saves model load
    cost in code paths where the retrieval step might find nothing."""
    fake = _FakeCrossEncoder(scores=[])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank("q", [])
    assert out == []
    assert fake.calls == []


# ---- pair shape ----------------------------------------------------------


async def test_rerank_passes_query_paired_with_each_candidate_text():
    """Cross-encoders score (query, document) pairs jointly. The
    wrapper must wire the same query into every pair, in the same
    order as the candidates."""
    fake = _FakeCrossEncoder(scores=[0.1, 0.2])
    reranker = LocalReranker(model=fake)

    await reranker.rerank("die frage", _candidates(["doc a", "doc b"]))

    assert fake.calls == [[("die frage", "doc a"), ("die frage", "doc b")]]


async def test_rerank_preserves_candidate_id_passthrough():
    """Reranker doesn't synthesise ids — whatever the caller put in
    `RerankCandidate.id` comes back verbatim, so caller code can
    stitch reranked scores onto its own candidate shape."""
    fake = _FakeCrossEncoder(scores=[0.5, 0.6])
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank(
        "q",
        [
            RerankCandidate(id="qdrant-uuid-1", text="x"),
            RerankCandidate(id="qdrant-uuid-2", text="y"),
        ],
    )
    assert {r.id for r in out} == {"qdrant-uuid-1", "qdrant-uuid-2"}


# ---- model + name properties --------------------------------------------


async def test_default_model_pinned_to_bge_reranker_v2_m3():
    reranker = LocalReranker(model=_FakeCrossEncoder([]))
    assert reranker.model == DEFAULT_RERANKER_MODEL == "BAAI/bge-reranker-v2-m3"


async def test_model_override_passed_through():
    reranker = LocalReranker(
        model_name="BAAI/bge-reranker-base", model=_FakeCrossEncoder([])
    )
    assert reranker.model == "BAAI/bge-reranker-base"


async def test_name_property_returns_sentence_transformers():
    reranker = LocalReranker(model=_FakeCrossEncoder([]))
    assert reranker.name == "sentence-transformers"


# ---- protocol conformance -----------------------------------------------


async def test_local_reranker_satisfies_reranker_protocol():
    """Catches accidental signature drift between Reranker and
    LocalReranker that mypy would flag but plain pytest wouldn't."""
    reranker = LocalReranker(model=_FakeCrossEncoder([]))
    assert isinstance(reranker, Reranker)


# ---- output dataclass shape ---------------------------------------------


async def test_rerank_result_is_frozen():
    """Reranked results are passed by reference through the answer
    pipeline; freezing prevents accidental mutation downstream."""
    r = RerankResult(id="x", score=0.5)
    with pytest.raises(Exception):  # noqa: BLE001 — FrozenInstanceError
        r.score = 0.6  # type: ignore[misc]


async def test_rerank_candidate_is_frozen():
    c = RerankCandidate(id="x", text="y")
    with pytest.raises(Exception):  # noqa: BLE001
        c.text = "z"  # type: ignore[misc]


# ---- score type coercion ------------------------------------------------


async def test_rerank_coerces_score_to_float():
    """numpy scalars from real CrossEncoder.predict are coerced to
    plain Python floats so the shape is JSON-serializable for log
    payloads / API responses without extra adapters."""
    import numpy as np

    fake = _FakeCrossEncoder(scores=[np.float32(0.7), np.float32(0.3)])  # type: ignore[arg-type]
    reranker = LocalReranker(model=fake)

    out = await reranker.rerank("q", _candidates(["a", "b"]))

    assert all(isinstance(r.score, float) for r in out)
    assert all(not isinstance(r.score, np.floating) for r in out)
