"""Indexer worker for the RAG indexing pipeline (RAG Phase 1.5).

Triggered by the propagator the moment a document reaches `ai-propagated`,
this module composes the chunker (1.1), the embedder (1.2), and the
Qdrant vector store wrapper (1.3) into a single coherent flow:

    fetch content from Paperless
        ↓
    chunk into ~500-token paragraph-aware windows (with overlap)
        ↓
    batch-embed each chunk via Ollama bge-m3
        ↓
    delete any existing chunks for this doc_id (idempotent reindex)
        ↓
    upsert into Qdrant with payload denormalised so structural filters
    apply at the vector layer (doc_type, correspondent, tags, date)

Failure tags `ai-index-error` so the SPA can surface "indexed but
broken" docs and the user can retry. Success removes a stale
`ai-index-error` tag if one is present so the lifecycle state stays
honest after a recovery.

Design choices captured here:

- **The indexer is opt-in via QDRANT_URL.** When the URL is empty (the
  default in env templates), the auto-tagger constructs no vector
  store, runs no indexer task, and the propagator does not enqueue.
  This keeps the existing extraction + propagation path working when
  the RAG infra is intentionally disabled (developer hacking, a
  buyer who hasn't pulled bge-m3 yet).
- **Errors do not bubble out of `index_document`.** The worker
  catches everything, tags `ai-index-error`, and returns — the
  asyncio.gather in main.py must keep running across per-doc
  failures. The task_done() bookkeeping happens in the worker that
  invokes us.
- **The fetch is by id, not by passing the doc dict.** Propagation
  has just mutated the doc's tags and (for AI-suggested tags) added
  new ones; reading the freshest copy avoids a stale-payload bug
  where the indexed `tags` payload doesn't match the live state.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type
from datetime import datetime

import structlog
from aktenraum_core.paperless import PaperlessClient
from aktenraum_core.rag import Chunk, Embedder, QdrantVectorStore, chunk_text

log = structlog.get_logger()


# Tag we apply when indexing fails. NOT in LIFECYCLE_TAGS: the doc has
# already completed extraction + propagation, so the auto-tagger's
# extraction-skip logic must keep ignoring it. This is purely an
# auxiliary visibility flag, like `ai-low-confidence`.
INDEX_ERROR_TAG = "ai-index-error"

# Cap chunks per document so a runaway OCR result (a 1000-page scan, an
# accidental concatenation) cannot DoS the embedder or balloon the
# Qdrant collection. Personal-DMS scale: a 30-page contract chunks to
# ~80 entries with our 500-token target, so 200 leaves comfortable
# headroom while bounding worst-case work.
_MAX_CHUNKS_PER_DOC = 200


@dataclass
class IndexingDeps:
    """Bag of collaborators the indexer needs. Constructed once at
    auto-tagger startup and shared by every invocation. Keeping these
    as a dataclass (rather than positional args) makes the unit tests
    almost trivially mockable."""

    paperless: PaperlessClient
    embedder: Embedder
    vector_store: QdrantVectorStore


async def index_document(doc_id: int, deps: IndexingDeps) -> None:
    """Index one document end-to-end. Tolerates every per-doc failure.

    The function is idempotent: re-running on an already-indexed doc
    deletes the prior chunks and re-upserts. Re-running on a doc with
    no content is a no-op (we do delete-by-doc to clear any stale
    chunks, but skip the chunk/embed/upsert path).
    """
    logger = log.bind(doc_id=doc_id, loop="indexer")
    try:
        doc = await deps.paperless.get_document(doc_id)
    except Exception as exc:
        logger.warning("indexer_fetch_failed", error=str(exc))
        return

    content = await _read_content(deps.paperless, doc)
    chunks = chunk_text(content) if content else []

    if len(chunks) > _MAX_CHUNKS_PER_DOC:
        logger.warning(
            "indexer_chunks_truncated",
            produced=len(chunks),
            kept=_MAX_CHUNKS_PER_DOC,
        )
        chunks = chunks[:_MAX_CHUNKS_PER_DOC]

    payload_meta = await _resolve_payload_metadata(deps.paperless, doc)

    try:
        # Always delete first so a re-index never leaves stale chunks
        # behind (e.g. document was edited and now has fewer chunks).
        # Idempotent: no-op when the doc isn't currently indexed.
        await deps.vector_store.delete_by_doc_id(doc_id)

        if not chunks:
            logger.info("indexer_no_content", chars=len(content))
            await _clear_index_error_tag_if_present(deps.paperless, doc)
            return

        embeddings = await deps.embedder.embed_dense(
            [c.text for c in chunks]
        )
        written = await deps.vector_store.upsert_chunks(
            chunks=chunks,
            embeddings=embeddings,
            doc_id=doc_id,
            doc_type=payload_meta.doc_type,
            correspondent=payload_meta.correspondent,
            tags=payload_meta.tags,
            created_date=payload_meta.created_date,
        )
        logger.info(
            "indexer_doc_indexed",
            chunks_written=written,
            content_chars=len(content),
        )
        await _clear_index_error_tag_if_present(deps.paperless, doc)
    except Exception as exc:
        logger.exception("indexer_failed", error=str(exc))
        try:
            await _tag_index_error(deps.paperless, doc)
        except Exception as inner:
            logger.error("indexer_tag_failed", error=str(inner))


async def _read_content(paperless: PaperlessClient, doc: dict) -> str:
    """Use the inline `content` field if Paperless populated it on the
    initial fetch (it usually does for `/api/documents/<id>/`),
    otherwise hit `/content/` directly. Some doc shapes carry it,
    others don't — being defensive keeps the indexer robust to changes
    in PaperlessClient.get_document's projection."""
    inline = doc.get("content")
    if isinstance(inline, str) and inline.strip():
        return inline
    try:
        return await paperless.get_document_content(doc["id"])
    except Exception:
        log.warning("indexer_content_fetch_failed", doc_id=doc.get("id"))
        return ""


@dataclass(frozen=True)
class _PayloadMeta:
    doc_type: str | None
    correspondent: str | None
    tags: tuple[str, ...]
    created_date: date_type | None


async def _resolve_payload_metadata(
    paperless: PaperlessClient, doc: dict
) -> _PayloadMeta:
    """Project the live Paperless doc into the metadata fields we
    denormalise into each chunk's Qdrant payload. Resolves FK ids to
    names via Paperless's `/api/<endpoint>/` listings; falls back to
    the AI custom field when the native FK is unset (which can happen
    for legacy docs or rejected propagations that left the AI fields
    dangling).

    Each call hits Paperless three times for the entity-name maps —
    fine at personal-DMS scale because indexing is rate-limited by
    embedding latency. If/when this becomes hot, lift the maps to a
    short-lived per-process cache (the PaperlessGateway in
    aktenraum-api already does this; we'd lift the same pattern
    here).
    """
    correspondent_map: dict[int, str] = {}
    document_type_map: dict[int, str] = {}
    tag_map: dict[int, str] = {}
    try:
        correspondent_map = await paperless.get_entity_name_map(
            "/api/correspondents/"
        )
        document_type_map = await paperless.get_entity_name_map(
            "/api/document_types/"
        )
        tag_map = await paperless.get_entity_name_map("/api/tags/")
    except Exception:
        # Best-effort: missing maps just produce a payload with `None`
        # / empty values for the unresolved fields. Indexing still
        # succeeds; structural filters on those fields just won't hit.
        log.warning("indexer_entity_map_fetch_failed", exc_info=True)

    correspondent_name: str | None = None
    if (cid := doc.get("correspondent")) is not None:
        correspondent_name = correspondent_map.get(cid)

    document_type_name: str | None = None
    if (tid := doc.get("document_type")) is not None:
        document_type_name = document_type_map.get(tid)

    if not correspondent_name or not document_type_name:
        # Fall back to AI fields when a native FK is unset.
        try:
            ai = await paperless.get_ai_custom_field_values(doc["id"])
        except Exception:
            ai = {}
        correspondent_name = correspondent_name or (
            ai.get("ai_correspondent") or None
        )
        document_type_name = document_type_name or (
            ai.get("ai_document_type") or None
        )

    tag_names = _filter_user_tags(doc.get("tags") or [], tag_map)
    created = _parse_date(doc.get("created_date") or doc.get("created"))

    return _PayloadMeta(
        doc_type=document_type_name,
        correspondent=correspondent_name,
        tags=tuple(tag_names),
        created_date=created,
    )


def _filter_user_tags(
    tag_ids: list[int], tag_map: dict[int, str]
) -> list[str]:
    """Resolve tag ids to user-facing names, EXCLUDING any lifecycle /
    auxiliary tag (we don't want `ai-propagated` or `ai-index-error`
    itself sneaking into the searchable tag payload). Pure function so
    it's trivially testable."""
    from aktenraum_core.paperless import LIFECYCLE_TAGS

    excluded = set(LIFECYCLE_TAGS) | {"ai-low-confidence", INDEX_ERROR_TAG}
    out: list[str] = []
    for tid in tag_ids:
        name = tag_map.get(tid)
        if name and name not in excluded:
            out.append(name)
    return out


def _parse_date(value: object) -> date_type | None:
    if value is None:
        return None
    if isinstance(value, date_type):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date_type.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


async def _tag_index_error(paperless: PaperlessClient, doc: dict) -> None:
    """Apply `ai-index-error` to the doc as a visible recovery flag.
    Idempotent: applying when already present is a no-op upstream."""
    error_id = await paperless.get_or_create_tag(INDEX_ERROR_TAG)
    current = list(doc.get("tags") or [])
    if error_id in current:
        return
    new_tags = sorted({*current, error_id})
    await paperless.patch_document_native_fields(doc["id"], tags=new_tags)


async def _clear_index_error_tag_if_present(
    paperless: PaperlessClient, doc: dict
) -> None:
    """Remove `ai-index-error` after a successful index. Without this
    the SPA would keep showing the error pill even though the issue
    has self-healed."""
    error_id = await paperless._get_tag_id(INDEX_ERROR_TAG)  # noqa: SLF001
    if error_id is None:
        return
    current = list(doc.get("tags") or [])
    if error_id not in current:
        return
    new_tags = sorted(set(current) - {error_id})
    await paperless.patch_document_native_fields(doc["id"], tags=new_tags)


# Re-export for callers that need the shape — keeps indexer imports tidy.
__all__ = ["INDEX_ERROR_TAG", "Chunk", "IndexingDeps", "index_document"]
