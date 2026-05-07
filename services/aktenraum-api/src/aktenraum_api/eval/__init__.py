"""RAG retrieval-quality evaluation harness (Phase 1.10).

Two pieces:

  - `metrics`: pure-function evaluators (recall@K, MRR per-question
    + aggregate). Tested in isolation, no I/O.
  - `runner`: CLI that loads a YAML golden-question file, runs every
    question through the live `retrieve_chunks_for_question`, and
    emits a per-question + aggregate report.

The framework is the credibility piece: without measurements, "best-
in-class retrieval" is unsubstantiated marketing. With it, every
prompt / model / chunker change can be evaluated against the same
fixed set so improvements are observable and regressions are
blockable.
"""

from .metrics import (
    EvalCase,
    EvalReport,
    EvalResult,
    aggregate,
    score_case,
)

__all__ = [
    "EvalCase",
    "EvalReport",
    "EvalResult",
    "aggregate",
    "score_case",
]
