"""Pure-function retrieval-quality metrics.

Two metrics, both standard in IR literature:

  - **Recall@K**: did at least one expected doc surface in the top-K
    retrieved? Measures coverage. The headline number for a personal
    DMS — if recall@5 is below 80%, users find the system unreliable
    even when the LLM step is perfect.
  - **MRR (mean reciprocal rank)**: how high in the ranked list did
    the FIRST expected doc appear? Measures ordering quality.
    1 / position_of_first_match, averaged across questions. MRR=1
    means every right answer is at rank 1; MRR=0.5 means rank 2 on
    average; MRR=0 means never found.

Both metrics work per-question and aggregate over a case set. Cases
that returned ANY expected doc inside the configured top-K count as
hits for recall@K; the same case's reciprocal rank goes into MRR.
Cases where retrieval returned nothing at all count as 0.0 in MRR
and as a miss for recall@K — a hard floor we can't average around.

Written so the runner stays a thin orchestration layer; everything
testable lives here.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class EvalCase:
    """One golden-question entry from `evals/golden-questions.yaml`.

    `id` is a stable handle so reports can be diffed across runs;
    use kebab-case strings like `cv-employment-duration`. `expected`
    is the set of doc ids that count as a correct retrieval — usually
    one, sometimes two (a question that could legitimately be answered
    from either of two filings).
    """

    id: str
    question: str
    expected: tuple[int, ...]
    expected_in_top_k: int = 5
    category: str | None = None
    language: str = "de"


@dataclass(frozen=True)
class EvalResult:
    """Per-case evaluation outcome."""

    case_id: str
    question: str
    expected: tuple[int, ...]
    retrieved: tuple[int, ...]
    hit_at_k: bool
    reciprocal_rank: float
    rank_of_first_hit: int | None  # None when no hit


@dataclass(frozen=True)
class EvalReport:
    """Aggregate report across an EvalCase set."""

    total_cases: int
    hits: int
    misses: int
    recall_at_k: float
    mrr: float
    per_case: tuple[EvalResult, ...]


def score_case(
    case: EvalCase, retrieved_doc_ids: Sequence[int]
) -> EvalResult:
    """Score one case against the ranked doc-id list returned by
    retrieval. Order matters — the input list MUST be sorted by
    descending relevance score.

    `retrieved_doc_ids` SHOULD already be deduped (the production
    pipeline dedupes when grouping chunks by doc); we don't re-dedupe
    here so a buggy upstream that returns duplicates surfaces as
    bad MRR rather than getting silently sanitised.
    """
    expected = set(case.expected)
    rank_of_first_hit: int | None = None
    for idx, doc_id in enumerate(retrieved_doc_ids, start=1):
        if doc_id in expected:
            rank_of_first_hit = idx
            break

    hit_at_k = (
        rank_of_first_hit is not None
        and rank_of_first_hit <= case.expected_in_top_k
    )
    reciprocal_rank = (
        1.0 / rank_of_first_hit if rank_of_first_hit is not None else 0.0
    )
    return EvalResult(
        case_id=case.id,
        question=case.question,
        expected=case.expected,
        retrieved=tuple(retrieved_doc_ids),
        hit_at_k=hit_at_k,
        reciprocal_rank=reciprocal_rank,
        rank_of_first_hit=rank_of_first_hit,
    )


def aggregate(results: Sequence[EvalResult]) -> EvalReport:
    """Roll per-case results into a single report.

    Empty input returns a zeroed report rather than dividing by zero
    — mirrors the "no cases" case the runner hits on a fresh repo
    before any golden questions are written.
    """
    total = len(results)
    if total == 0:
        return EvalReport(
            total_cases=0,
            hits=0,
            misses=0,
            recall_at_k=0.0,
            mrr=0.0,
            per_case=(),
        )
    hits = sum(1 for r in results if r.hit_at_k)
    misses = total - hits
    recall_at_k = hits / total
    mrr = sum(r.reciprocal_rank for r in results) / total
    return EvalReport(
        total_cases=total,
        hits=hits,
        misses=misses,
        recall_at_k=recall_at_k,
        mrr=mrr,
        per_case=tuple(results),
    )
