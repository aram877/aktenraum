"""Live RAG eval runner.

Loads `evals/golden-questions.yaml`, runs every question through
`retrieve_chunks_for_question` against the live Qdrant + Ollama
deps, and prints a per-case + aggregate report.

CLI:
    python -m aktenraum_api.eval.runner [--cases <path>] [--top-k N] [--json]

Default `cases` path: `evals/golden-questions.yaml` resolved against
the project root mounted into the aktenraum-api container at /app.

Exit code is 0 on success regardless of metrics — a low recall is a
signal, not an error. The wrapper script (or CI) decides whether to
fail based on threshold.

Output formats:
- text (default): human-readable, headline metrics + per-case rows.
  Easier to eyeball in a terminal than diff-friendly JSON.
- --json: stable JSON with per-case + aggregate, suitable for
  automation (compare-with-previous, threshold gate in CI).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Iterable
from pathlib import Path

import yaml
from aktenraum_core.rag import LocalReranker, OllamaEmbedder, QdrantVectorStore

from ..ai.retrieval import RetrievalDeps, retrieve_chunks_for_question
from ..config import Settings
from .metrics import EvalCase, EvalReport, EvalResult, aggregate, score_case

# Default location relative to repo root (the path inside the
# aktenraum-api container after compose mounts).
DEFAULT_CASES = Path("/app/evals/golden-questions.yaml")


def load_cases(path: Path) -> list[EvalCase]:
    """Parse the golden-question YAML into typed cases.

    Schema (one mapping per list item):
        - id: str            (required, kebab-case)
          question: str      (required)
          expected_doc_ids: list[int]  (required, length >= 1)
          expected_in_top_k: int       (optional, default 5)
          category: str      (optional, free-form classifier)
          language: str      (optional, default "de")

    Raises ValueError on a malformed entry — a typo'd `id` becomes a
    fail-fast run rather than a silently-skipped case.
    """
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(
            f"{path} top-level must be a YAML list of cases, got {type(raw).__name__}"
        )
    cases: list[EvalCase] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(f"{path} entry #{i} is not a mapping")
        required = {"id", "question", "expected_doc_ids"}
        missing = required - set(entry.keys())
        if missing:
            raise ValueError(
                f"{path} entry #{i} ({entry.get('id')!r}) missing keys: {sorted(missing)}"
            )
        expected = entry["expected_doc_ids"]
        if not isinstance(expected, list) or not expected:
            raise ValueError(
                f"{path} entry {entry['id']!r}: expected_doc_ids must be a non-empty list"
            )
        cases.append(
            EvalCase(
                id=str(entry["id"]),
                question=str(entry["question"]),
                expected=tuple(int(x) for x in expected),
                expected_in_top_k=int(entry.get("expected_in_top_k", 5)),
                category=entry.get("category"),
                language=str(entry.get("language", "de")),
            )
        )
    return cases


def build_deps_from_settings(settings: Settings) -> RetrievalDeps:
    """Construct the same RetrievalDeps the live API uses."""
    if not settings.qdrant_url:
        raise RuntimeError(
            "QDRANT_URL is empty — the eval runner cannot run without "
            "RAG infrastructure. Set QDRANT_URL in aktenraum-api.env "
            "and re-run."
        )
    return RetrievalDeps(
        embedder=OllamaEmbedder(
            base_url=settings.ollama_base_url,
            model=settings.embedding_model,
        ),
        vector_store=QdrantVectorStore(
            url=settings.qdrant_url, dense_dim=1024
        ),
        reranker=LocalReranker(model_name=settings.reranker_model),
    )


async def evaluate(
    cases: Iterable[EvalCase],
    *,
    deps: RetrievalDeps,
    top_k: int,
) -> EvalReport:
    """Run every case through retrieval, score, aggregate."""
    results: list[EvalResult] = []
    for case in cases:
        chunks = await retrieve_chunks_for_question(
            case.question, deps=deps, rerank_top_k=top_k
        )
        # Dedupe doc_ids while preserving order so MRR sees one entry
        # per doc — the same dedupe logic the answer endpoint uses.
        seen: set[int] = set()
        ranked: list[int] = []
        for c in chunks:
            if c.doc_id in seen:
                continue
            seen.add(c.doc_id)
            ranked.append(c.doc_id)
        results.append(score_case(case, ranked))
    return aggregate(results)


def render_text(report: EvalReport) -> str:
    """Pretty-print for terminal eyeballing. Human-readable only —
    automation should consume `--json` instead."""
    lines: list[str] = []
    lines.append("=" * 60)
    lines.append("aktenraum RAG eval report")
    lines.append("=" * 60)
    lines.append(f"  cases: {report.total_cases}")
    lines.append(f"  hits:  {report.hits}")
    lines.append(f"  miss:  {report.misses}")
    lines.append(f"  recall@K: {report.recall_at_k:.3f}")
    lines.append(f"  MRR:      {report.mrr:.3f}")
    lines.append("")
    lines.append("per-case:")
    for r in report.per_case:
        marker = "✓" if r.hit_at_k else "✗"
        rank = (
            str(r.rank_of_first_hit)
            if r.rank_of_first_hit is not None
            else "—"
        )
        retrieved_preview = ", ".join(str(d) for d in r.retrieved[:5])
        lines.append(
            f"  {marker} {r.case_id:<28} rank={rank:<3} "
            f"expected={list(r.expected)} retrieved=[{retrieved_preview}…]"
        )
    return "\n".join(lines)


def render_json(report: EvalReport) -> str:
    """Stable JSON for diff-with-previous and CI threshold gates."""
    payload = {
        "total_cases": report.total_cases,
        "hits": report.hits,
        "misses": report.misses,
        "recall_at_k": report.recall_at_k,
        "mrr": report.mrr,
        "per_case": [
            {
                "case_id": r.case_id,
                "question": r.question,
                "expected": list(r.expected),
                "retrieved": list(r.retrieved),
                "hit_at_k": r.hit_at_k,
                "reciprocal_rank": r.reciprocal_rank,
                "rank_of_first_hit": r.rank_of_first_hit,
            }
            for r in report.per_case
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="aktenraum-eval")
    parser.add_argument(
        "--cases",
        type=Path,
        default=DEFAULT_CASES,
        help="Path to golden-questions YAML.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="Reranker top-K (matches the answer pipeline default).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of human-readable text.",
    )
    args = parser.parse_args(argv)

    if not args.cases.exists():
        sys.stderr.write(
            f"No cases file at {args.cases} — write your first golden "
            "questions and re-run. See docs/plans/rag-phase-1.md for "
            "the schema.\n"
        )
        return 1

    cases = load_cases(args.cases)
    if not cases:
        sys.stderr.write(f"{args.cases} has no cases.\n")
        return 1

    settings = Settings()
    deps = build_deps_from_settings(settings)
    try:
        await deps.vector_store.ensure_collection()
        report = await evaluate(cases, deps=deps, top_k=args.top_k)
    finally:
        await deps.vector_store.aclose()

    if args.json:
        sys.stdout.write(render_json(report) + "\n")
    else:
        sys.stdout.write(render_text(report) + "\n")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()
