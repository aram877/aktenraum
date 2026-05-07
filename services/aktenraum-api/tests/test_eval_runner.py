"""Unit tests for the eval runner — YAML loading, evaluation
orchestration, and output rendering."""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from aktenraum_core.rag import ChunkPayload, RerankResult, SearchHit

from aktenraum_api.ai.retrieval import RetrievalDeps
from aktenraum_api.eval.metrics import EvalCase
from aktenraum_api.eval.runner import (
    evaluate,
    load_cases,
    render_json,
    render_text,
)

# ---- load_cases ----------------------------------------------------------


def _write_yaml(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "cases.yaml"
    p.write_text(content, encoding="utf-8")
    return p


def test_load_cases_parses_minimal_entry(tmp_path: Path):
    path = _write_yaml(
        tmp_path,
        """
- id: cv-kopfstand
  question: Wie lange?
  expected_doc_ids: [25]
""",
    )
    cases = load_cases(path)
    assert len(cases) == 1
    assert cases[0].id == "cv-kopfstand"
    assert cases[0].expected == (25,)
    # Defaults filled in.
    assert cases[0].expected_in_top_k == 5
    assert cases[0].language == "de"


def test_load_cases_supports_optional_fields(tmp_path: Path):
    path = _write_yaml(
        tmp_path,
        """
- id: cv-multi
  question: Wo studiert?
  expected_doc_ids: [16, 25]
  expected_in_top_k: 3
  category: cv-education
  language: de
""",
    )
    cases = load_cases(path)
    assert cases[0].expected == (16, 25)
    assert cases[0].expected_in_top_k == 3
    assert cases[0].category == "cv-education"


def test_load_cases_empty_file_returns_empty_list(tmp_path: Path):
    path = _write_yaml(tmp_path, "")
    assert load_cases(path) == []


def test_load_cases_rejects_non_list_top_level(tmp_path: Path):
    path = _write_yaml(tmp_path, "{not: a, list: yes}")
    with pytest.raises(ValueError, match="top-level must be a YAML list"):
        load_cases(path)


def test_load_cases_rejects_missing_required_keys(tmp_path: Path):
    path = _write_yaml(tmp_path, "- id: x\n  question: q\n")
    with pytest.raises(ValueError, match="missing keys"):
        load_cases(path)


def test_load_cases_rejects_empty_expected_doc_ids(tmp_path: Path):
    path = _write_yaml(
        tmp_path,
        """
- id: x
  question: q
  expected_doc_ids: []
""",
    )
    with pytest.raises(ValueError, match="non-empty list"):
        load_cases(path)


# ---- evaluate ------------------------------------------------------------


def _payload(doc_id: int, idx: int = 0) -> ChunkPayload:
    return ChunkPayload(
        doc_id=doc_id,
        chunk_index=idx,
        text=f"chunk for doc {doc_id}",
        char_start=0,
        char_end=10,
        token_count=2,
    )


def _hit(doc_id: int, score: float = 0.5) -> SearchHit:
    return SearchHit(score=score, payload=_payload(doc_id))


def _make_deps(*, retrieval_results: dict[str, list[int]]) -> RetrievalDeps:
    """Build deps where the embedder + qdrant + reranker compose into
    `retrieve_chunks_for_question` returning a scripted ranked doc-id
    list per question."""
    embedder = MagicMock()
    embedder.embed_dense = AsyncMock(return_value=[[0.1] * 1024])
    embedder.dense_dim = 1024
    embedder.model = "bge-m3"

    vector_store = MagicMock()

    async def _search(*, query_vector, top_k, filter):  # noqa: A002
        # The test asks the runner one question at a time; we look up
        # the most-recently-asked question via the embedder's calls.
        call = embedder.embed_dense.await_args
        if call is None:
            return []
        question = call.args[0][0]
        doc_ids = retrieval_results.get(question, [])
        return [_hit(d) for d in doc_ids]

    vector_store.search = AsyncMock(side_effect=_search)

    reranker = MagicMock()

    async def _rerank(query, candidates, *, top_k):
        # Pass through in input order — equivalent to "no reranking".
        return [
            RerankResult(id=c.id, score=1.0 - i * 0.01)
            for i, c in enumerate(candidates[:top_k])
        ]

    reranker.rerank = AsyncMock(side_effect=_rerank)
    reranker.name = "stub"
    reranker.model = "stub"

    return RetrievalDeps(
        embedder=embedder, vector_store=vector_store, reranker=reranker
    )


async def test_evaluate_aggregates_hits_and_misses():
    cases = [
        EvalCase(id="a", question="qa", expected=(1,)),
        EvalCase(id="b", question="qb", expected=(2,)),
        EvalCase(id="c", question="qc", expected=(99,)),  # miss
    ]
    deps = _make_deps(
        retrieval_results={
            "qa": [1, 5, 6],
            "qb": [4, 2, 3],
            "qc": [7, 8],
        }
    )

    report = await evaluate(cases, deps=deps, top_k=5)

    assert report.total_cases == 3
    assert report.hits == 2
    assert report.misses == 1
    assert report.recall_at_k == 2 / 3
    # MRR = (1/1 + 1/2 + 0) / 3
    assert abs(report.mrr - (1.0 + 0.5 + 0.0) / 3) < 1e-9


async def test_evaluate_dedupes_doc_ids_in_retrieval_order():
    """Production retrieval may return multiple chunks per doc; the
    runner dedupes preserving order so MRR sees one entry per doc.
    Here a single search returns chunks for the same doc twice; the
    rank should treat that as rank 1, not rank 2."""
    cases = [EvalCase(id="x", question="qx", expected=(7,))]
    deps = _make_deps(retrieval_results={"qx": [7, 7, 9]})

    report = await evaluate(cases, deps=deps, top_k=5)

    assert report.per_case[0].rank_of_first_hit == 1
    assert report.per_case[0].retrieved == (7, 9)


# ---- render_text + render_json -------------------------------------------


async def test_render_json_round_trips_through_json_loads():
    """Stable JSON for diffing across runs / CI gates."""
    cases = [EvalCase(id="x", question="qx", expected=(1,))]
    deps = _make_deps(retrieval_results={"qx": [1, 2]})
    report = await evaluate(cases, deps=deps, top_k=5)

    out = render_json(report)
    parsed = json.loads(out)

    assert parsed["total_cases"] == 1
    assert parsed["recall_at_k"] == 1.0
    assert parsed["per_case"][0]["case_id"] == "x"
    assert parsed["per_case"][0]["retrieved"] == [1, 2]


async def test_render_text_includes_aggregate_headlines():
    """Human-readable text output carries the headline numbers a
    developer scans after a change — recall@K and MRR."""
    cases = [EvalCase(id="x", question="qx", expected=(1,))]
    deps = _make_deps(retrieval_results={"qx": [1]})
    report = await evaluate(cases, deps=deps, top_k=5)

    out = render_text(report)
    assert "recall@K" in out
    assert "MRR" in out
    assert "x" in out  # case id


async def test_render_text_marks_hits_and_misses():
    cases = [
        EvalCase(id="hit", question="qa", expected=(1,)),
        EvalCase(id="miss", question="qb", expected=(99,)),
    ]
    deps = _make_deps(
        retrieval_results={"qa": [1], "qb": [3]}
    )
    report = await evaluate(cases, deps=deps, top_k=5)

    out = render_text(report)
    assert "✓ hit" in out or "hit" in out
    assert "✗ miss" in out or "miss" in out


# ---- end-to-end smoke ----------------------------------------------------


async def test_runner_pipeline_load_then_evaluate(tmp_path: Path):
    """Load cases from YAML, run them through evaluate, render JSON.
    Pins the full happy path even though no individual stage is new."""
    path = _write_yaml(
        tmp_path,
        """
- id: cv-kopfstand
  question: Wie lange?
  expected_doc_ids: [25]
""",
    )
    cases = load_cases(path)
    deps = _make_deps(retrieval_results={"Wie lange?": [25, 16]})

    report = await evaluate(cases, deps=deps, top_k=5)

    buf = io.StringIO()
    buf.write(render_json(report))
    parsed = json.loads(buf.getvalue())
    assert parsed["hits"] == 1
    assert parsed["misses"] == 0
