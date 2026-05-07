"""Unit tests for the RAG eval metrics (Phase 1.10).

Pure-function module — no I/O, no mocks needed. Pins the contract
for recall@K and MRR so downstream changes (chunker tweaks, reranker
swap, prompt tuning) can be evaluated against a stable yardstick.
"""

from __future__ import annotations

from aktenraum_api.eval.metrics import (
    EvalCase,
    aggregate,
    score_case,
)


def _case(case_id: str = "c", expected: tuple[int, ...] = (1,), top_k: int = 5) -> EvalCase:
    return EvalCase(
        id=case_id,
        question="?",
        expected=expected,
        expected_in_top_k=top_k,
    )


# ---- score_case: hit_at_k ------------------------------------------------


def test_hit_at_k_when_expected_in_first_position():
    r = score_case(_case(expected=(7,), top_k=5), [7, 1, 2, 3])
    assert r.hit_at_k is True
    assert r.rank_of_first_hit == 1


def test_hit_at_k_when_expected_at_top_k_boundary():
    """Boundary case: rank == top_k counts as a hit (inclusive)."""
    r = score_case(_case(expected=(7,), top_k=3), [1, 2, 7, 4])
    assert r.hit_at_k is True
    assert r.rank_of_first_hit == 3


def test_miss_when_expected_outside_top_k():
    """Just past the top_k boundary is a miss — pinning the inclusive
    semantics so a future refactor can't quietly turn it exclusive."""
    r = score_case(_case(expected=(7,), top_k=3), [1, 2, 4, 7])
    assert r.hit_at_k is False
    assert r.rank_of_first_hit == 4


def test_miss_when_expected_not_retrieved():
    r = score_case(_case(expected=(99,), top_k=5), [1, 2, 3, 4, 5])
    assert r.hit_at_k is False
    assert r.rank_of_first_hit is None


def test_miss_when_retrieved_empty():
    r = score_case(_case(expected=(1,), top_k=5), [])
    assert r.hit_at_k is False
    assert r.rank_of_first_hit is None


# ---- score_case: reciprocal rank -----------------------------------------


def test_reciprocal_rank_inverts_position():
    r = score_case(_case(expected=(7,)), [1, 2, 7, 4])
    assert r.reciprocal_rank == 1.0 / 3


def test_reciprocal_rank_first_match_wins_when_multiple_expected():
    """When two expected ids are valid, MRR uses the first-appearing
    one — measures "how fast can the user find a correct doc",
    which is the personal-DMS UX question."""
    r = score_case(_case(expected=(7, 9)), [9, 5, 7])
    assert r.reciprocal_rank == 1.0
    assert r.rank_of_first_hit == 1


def test_reciprocal_rank_zero_when_no_match():
    r = score_case(_case(expected=(7,)), [1, 2, 3])
    assert r.reciprocal_rank == 0.0


def test_reciprocal_rank_zero_when_empty():
    r = score_case(_case(expected=(7,)), [])
    assert r.reciprocal_rank == 0.0


# ---- aggregate -----------------------------------------------------------


def test_aggregate_empty_returns_zeroed_report():
    report = aggregate([])
    assert report.total_cases == 0
    assert report.hits == 0
    assert report.misses == 0
    assert report.recall_at_k == 0.0
    assert report.mrr == 0.0


def test_aggregate_recall_is_hit_count_over_total():
    results = [
        score_case(_case("a", expected=(1,)), [1]),  # hit
        score_case(_case("b", expected=(2,)), [99]),  # miss
        score_case(_case("c", expected=(3,)), [3, 4]),  # hit
    ]
    report = aggregate(results)
    assert report.total_cases == 3
    assert report.hits == 2
    assert report.misses == 1
    assert report.recall_at_k == 2 / 3


def test_aggregate_mrr_is_mean_of_reciprocal_ranks():
    results = [
        score_case(_case("a", expected=(1,)), [1]),  # rank 1 → 1.0
        score_case(_case("b", expected=(2,)), [99, 2]),  # rank 2 → 0.5
        score_case(_case("c", expected=(3,)), []),  # miss → 0.0
    ]
    report = aggregate(results)
    assert report.mrr == (1.0 + 0.5 + 0.0) / 3


def test_aggregate_per_case_preserves_input_order():
    """Reports diff cleanly between runs only if order is stable."""
    results = [
        score_case(_case("zzz", expected=(1,)), [1]),
        score_case(_case("aaa", expected=(2,)), [2]),
    ]
    report = aggregate(results)
    assert [r.case_id for r in report.per_case] == ["zzz", "aaa"]


# ---- EvalResult shape ----------------------------------------------------


def test_eval_result_carries_question_and_retrieved_for_diagnostics():
    """Per-case results need the question text + retrieved ids so a
    failed case can be diagnosed without rerunning the whole eval."""
    case = EvalCase(
        id="x",
        question="Was kostete die Stromrechnung?",
        expected=(42,),
        expected_in_top_k=5,
    )
    r = score_case(case, [99, 42, 13])
    assert r.question == "Was kostete die Stromrechnung?"
    assert r.retrieved == (99, 42, 13)


def test_eval_dataclasses_are_frozen():
    """Reports get serialised as JSON; frozen dataclasses prevent
    accidental mutation between aggregate() and render_json()."""
    import pytest

    case = _case()
    r = score_case(case, [1])
    with pytest.raises(Exception):  # noqa: BLE001 — FrozenInstanceError
        r.hit_at_k = False  # type: ignore[misc]


# ---- multiple-expected ---------------------------------------------------


def test_multiple_expected_either_counts():
    """A question that could legitimately be answered from doc 5 OR
    doc 7 (e.g. "wie lange habe ich bei <company> gearbeitet" when the
    information lives in BOTH the CV and a separate Arbeitszeugnis)
    counts as a hit when EITHER appears."""
    r = score_case(_case(expected=(5, 7)), [99, 7, 5])
    assert r.hit_at_k is True
    assert r.rank_of_first_hit == 2  # 7 came first


def test_multiple_expected_miss_when_neither_in_top_k():
    r = score_case(_case(expected=(5, 7), top_k=2), [99, 100, 5])
    assert r.hit_at_k is False
    assert r.rank_of_first_hit == 3
