"""Backfill the RAG vector index from existing `ai-propagated` documents
(RAG Phase 1.6).

Iterates every `ai-propagated` document in Paperless, checks whether it
already has chunks in Qdrant, and if not runs it through the same
`indexer.index_document` path as the live propagation hook. The script
is designed to be run:

  - Once after a fresh install, to populate the index from the existing
    corpus (otherwise only newly-propagated docs would be searchable).
  - Periodically as a self-heal in case the live indexer missed a doc
    (auto-tagger restart, Qdrant down during propagation, etc.).
  - On demand from the future desktop shell when the user wants to
    "rebuild the search index" via a settings panel.

Resumable + idempotent: re-running on a fully-indexed corpus is a fast
no-op (one cheap Qdrant count per doc, then skip). `--force` opts back
into re-indexing every doc regardless of current state — useful after
a chunker / embedder change.

Output is JSON-line events on stdout so the desktop shell can render
progress without parsing prose. Schema:

    {"event":"started","total":<int>}
    {"event":"doc_skipped","doc_id":<int>,"reason":"already_indexed"}
    {"event":"doc_indexed","doc_id":<int>}
    {"event":"doc_failed","doc_id":<int>,"error":"<short message>"}
    {"event":"completed","indexed":<int>,"skipped":<int>,"failed":<int>}

Errors during the iterating itself (Paperless down, can't list docs)
exit non-zero with a single error event so the caller can distinguish
"backfill ran but some docs failed" (exit 0, see counts) from
"backfill couldn't run" (exit non-zero).
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import IO, TextIO

import httpx
import structlog
from aktenraum_core.paperless import PaperlessClient
from aktenraum_core.rag import OllamaEmbedder, QdrantVectorStore

from .config import Settings
from .indexer import IndexingDeps, index_document

log = structlog.get_logger()


@dataclass
class BackfillReport:
    indexed: int = 0
    skipped: int = 0
    failed: int = 0


# Page size for the Paperless list scan. Larger than the auto-tagger's
# poll batch (5) because backfill runs to completion in one shot — fewer
# round-trips matter more than fairness with concurrent extraction.
_LIST_PAGE_SIZE = 100


async def iterate_propagated_doc_ids(
    paperless: PaperlessClient,
) -> AsyncIterator[int]:
    """Yield every `ai-propagated` doc id, paginating through all pages.

    The PaperlessClient's existing `get_documents_with_tag` returns only
    the first page; for backfill we need every page. We hit `/api/documents/`
    directly with `tags__id__all=<id>&page=N` until Paperless returns
    `next: null`. Yields ids only (callers fetch the full doc on demand)
    so memory stays bounded on large corpora.
    """
    tag_id = await paperless._get_tag_id("ai-propagated")  # noqa: SLF001
    if tag_id is None:
        return
    page = 1
    while True:
        resp = await paperless._client.get(  # noqa: SLF001
            "/api/documents/",
            params={
                "tags__id__all": tag_id,
                "ordering": "id",  # stable ordering across pages
                "page_size": _LIST_PAGE_SIZE,
                "page": page,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        for doc in body.get("results", []):
            yield int(doc["id"])
        # Paperless's pagination uses absolute URLs; presence of `next`
        # is the canonical "more pages" signal.
        if not body.get("next"):
            return
        page += 1


async def backfill_index(
    deps: IndexingDeps,
    *,
    force: bool = False,
    out: IO[str] | TextIO = sys.stdout,
) -> BackfillReport:
    """Run the backfill end-to-end. Returns a report; emits one JSON
    event per outcome to `out`.

    `force=True` re-indexes every doc regardless of its current Qdrant
    state. The default (`force=False`) skips docs that already have at
    least one chunk indexed — a re-run after a partial backfill picks
    up where it stopped.
    """
    report = BackfillReport()

    # First pass: collect every doc id so we can emit a `started` event
    # with the total. Yes, this means two listing scans (one for the
    # count, one for the work). Cheap relative to embedding cost; the
    # alternative — emitting `started` without a total — makes the
    # desktop shell's progress UI worse. Worth the round-trip.
    doc_ids: list[int] = []
    async for doc_id in iterate_propagated_doc_ids(deps.paperless):
        doc_ids.append(doc_id)

    _emit(out, {"event": "started", "total": len(doc_ids)})

    for doc_id in doc_ids:
        try:
            if not force:
                existing = await deps.vector_store.count_chunks_for_doc(doc_id)
                if existing > 0:
                    report.skipped += 1
                    _emit(
                        out,
                        {
                            "event": "doc_skipped",
                            "doc_id": doc_id,
                            "reason": "already_indexed",
                            "chunks": existing,
                        },
                    )
                    continue
            await index_document(doc_id, deps)
            # `index_document` swallows per-doc failures and tags
            # `ai-index-error` on the doc; the public signal we have
            # for "did it actually land in qdrant?" is to count again.
            written = await deps.vector_store.count_chunks_for_doc(doc_id)
            if written > 0:
                report.indexed += 1
                _emit(
                    out,
                    {
                        "event": "doc_indexed",
                        "doc_id": doc_id,
                        "chunks": written,
                    },
                )
            else:
                report.failed += 1
                _emit(
                    out,
                    {
                        "event": "doc_failed",
                        "doc_id": doc_id,
                        "error": "indexer ran but produced zero chunks",
                    },
                )
        except (httpx.HTTPError, RuntimeError, ValueError) as exc:
            # Catch the realistic failure surface (network, internal
            # invariants, value coercions) so one bad doc doesn't kill
            # the whole backfill. Per-doc failures already log inside
            # `index_document`; surface a short summary here.
            report.failed += 1
            _emit(
                out,
                {
                    "event": "doc_failed",
                    "doc_id": doc_id,
                    "error": str(exc)[:200],
                },
            )

    _emit(
        out,
        {
            "event": "completed",
            "indexed": report.indexed,
            "skipped": report.skipped,
            "failed": report.failed,
        },
    )
    return report


def _emit(out: IO[str] | TextIO, payload: dict) -> None:
    """Write one JSON-line event and flush. Flushing matters: when the
    desktop shell reads stdout for progress UI, buffered writes would
    mean no visible progress until the script finishes."""
    out.write(json.dumps(payload, ensure_ascii=False) + "\n")
    out.flush()


async def _amain(force: bool) -> int:
    """Async main: build deps from env, run backfill, return exit code.

    Returns 0 even if some individual docs failed (caller reads counts
    from the JSON output). Returns non-zero only when backfill itself
    couldn't run — e.g. Paperless unreachable, Qdrant misconfigured.
    """
    settings = Settings()
    settings.validate_backend()

    if not settings.qdrant_url:
        sys.stderr.write(
            "QDRANT_URL is empty — RAG indexing is not configured. "
            "Set QDRANT_URL in auto-tagger.env and re-run.\n"
        )
        return 2

    async with PaperlessClient(
        settings.paperless_base_url, settings.paperless_api_token
    ) as paperless:
        vector_store = QdrantVectorStore(url=settings.qdrant_url)
        try:
            await vector_store.ensure_collection()
            embedder = OllamaEmbedder(
                base_url=settings.ollama_base_url,
                model=settings.embedding_model,
            )
            deps = IndexingDeps(
                paperless=paperless, embedder=embedder, vector_store=vector_store
            )
            await backfill_index(deps, force=force)
        finally:
            await vector_store.aclose()
    return 0


def main() -> None:
    """CLI entry point. Invoke via `python -m auto_tagger.backfill` from
    inside the auto-tagger container (its env carries the right
    PAPERLESS_*, OLLAMA_*, QDRANT_URL values)."""
    force = "--force" in sys.argv
    code = asyncio.run(_amain(force=force))
    sys.exit(code)


if __name__ == "__main__":
    main()
