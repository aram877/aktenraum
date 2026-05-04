"""Qdrant wrapper for the RAG indexing and query paths.

Thin façade over `qdrant-client.AsyncQdrantClient` shaped to our actual
operations: ensure-collection, upsert chunks, delete by doc, search
with payload filters, and a health probe. Everything else qdrant-client
exposes is left untouched — callers should use this wrapper for the
indexed-corpus operations and reach for the raw client only for
exotic admin tasks.

Design choices captured here:

- **Point IDs are deterministic UUID5s of `(doc_id, chunk_index)`.** This
  gives us idempotent upserts (re-indexing the same doc replaces, never
  duplicates) without imposing a chunks-per-doc cap. The earlier
  `doc_id * 10000 + chunk_index` packing was rejected because a 30-page
  contract can blow past 10k chunks and the silent-overwrite failure
  mode is hostile to debug.
- **Payload schema is denormalised at upsert time.** We store
  `doc_type`, `correspondent`, `tags`, `created_date`, etc. inside each
  chunk's payload so query-time structural filters apply at the Qdrant
  layer instead of post-fetch. The cost is per-chunk redundancy
  (~200 bytes); the win is filterable retrieval without joining
  back to Paperless on every query.
- **Indexed payload fields are configured at collection-creation time.**
  Without explicit indexing, payload filters force a linear scan over
  all points. We opt-in to indexes for the fields we actually filter
  on (doc_id, doc_type, correspondent, tags). Adding a new filter
  field later requires `create_payload_index` separately — handled by
  `ensure_payload_indexes` so it's idempotent on existing collections.
- **Async-only.** The indexing worker is asyncio and the query path is
  FastAPI; a sync flavour would just bridge through `asyncio.to_thread`
  with no real benefit.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import structlog
from qdrant_client import AsyncQdrantClient, models

from .chunker import Chunk

log = structlog.get_logger()


# Default collection name. The desktop shell can override at construction
# time per tenant, but a single-user install never needs to know this.
DEFAULT_COLLECTION = "aktenraum_chunks"

# Stable namespace for deterministic chunk IDs. Generated once via
# `uuid.uuid4()` and frozen here — changing this string would orphan
# every existing chunk in the collection (point IDs would not match
# what re-indexing produces). DO NOT REGENERATE without a migration.
_POINT_ID_NAMESPACE = uuid.UUID("e9f31cae-1b4a-4c72-9b67-2a4b8b5ed45f")

# Payload fields we filter on at query time. Indexes here turn a linear
# scan over the entire collection into an O(log n) lookup. The schema
# kind matches what we store: doc_id is an integer; the rest are
# keyword (string) or keyword[] (list).
_INDEXED_PAYLOAD_FIELDS: dict[str, models.PayloadSchemaType] = {
    "doc_id": models.PayloadSchemaType.INTEGER,
    "doc_type": models.PayloadSchemaType.KEYWORD,
    "correspondent": models.PayloadSchemaType.KEYWORD,
    "tags": models.PayloadSchemaType.KEYWORD,
}


@dataclass(frozen=True)
class ChunkPayload:
    """Per-chunk metadata stored alongside its vector.

    Includes the chunk's text so the answer LLM can read it directly
    from a search hit without a second round-trip to Paperless. This
    triples per-chunk storage but eliminates an N+1 fetch on every
    query, which dominates latency on personal-DMS scale.
    """

    doc_id: int
    chunk_index: int
    text: str
    char_start: int
    char_end: int
    token_count: int
    doc_type: str | None = None
    correspondent: str | None = None
    tags: tuple[str, ...] = ()
    created_date: date | None = None
    page: int | None = None


@dataclass(frozen=True)
class SearchHit:
    """One result returned by `QdrantVectorStore.search`.

    `score` is the Qdrant similarity score (cosine, higher is closer).
    `payload` is the same data we wrote at upsert time.
    """

    score: float
    payload: ChunkPayload


@dataclass(frozen=True)
class SearchFilter:
    """Server-side narrowing applied at the vector layer.

    Every field is optional; the absence of all of them means an
    unconstrained nearest-neighbour search. Multi-value filters
    (e.g. multiple tags) use Qdrant's "match any" semantics; AND
    semantics across different fields are implicit (`MUST`).
    """

    doc_types: Sequence[str] = ()
    correspondents: Sequence[str] = ()
    tags: Sequence[str] = ()
    doc_ids: Sequence[int] = ()


class QdrantVectorStore:
    """Production wrapper around `AsyncQdrantClient`.

    The optional `client` parameter is a dependency-injection seam for
    testing — pass a fake that mimics the methods we use, and the
    wrapper exercises against it without touching the network. In
    production callers pass `url` and the constructor builds the real
    client.
    """

    def __init__(
        self,
        url: str,
        *,
        collection: str = DEFAULT_COLLECTION,
        dense_dim: int = 1024,
        client: AsyncQdrantClient | None = None,
    ) -> None:
        self._client = client or AsyncQdrantClient(url=url, prefer_grpc=False)
        self._collection = collection
        self._dense_dim = dense_dim

    @property
    def collection(self) -> str:
        return self._collection

    async def aclose(self) -> None:
        """Close the underlying httpx connection pool. Call on shutdown."""
        # AsyncQdrantClient exposes `close()` on recent versions; older
        # versions named it `aclose()`. Try both gracefully so we don't
        # tie this wrapper to a single qdrant-client minor version.
        close = getattr(self._client, "close", None) or getattr(
            self._client, "aclose", None
        )
        if close is None:
            return
        result = close()
        # Some versions return a coroutine, others return None synchronously.
        if hasattr(result, "__await__"):
            await result

    async def ensure_collection(self) -> None:
        """Create the collection if it doesn't exist; ensure payload
        indexes either way. Idempotent — safe to call on every service
        startup as the source of truth for the schema."""
        if not await self._client.collection_exists(self._collection):
            await self._client.create_collection(
                collection_name=self._collection,
                vectors_config=models.VectorParams(
                    size=self._dense_dim,
                    distance=models.Distance.COSINE,
                ),
            )
            log.info(
                "qdrant_collection_created",
                collection=self._collection,
                dense_dim=self._dense_dim,
            )
        await self._ensure_payload_indexes()

    async def _ensure_payload_indexes(self) -> None:
        """Create payload indexes that are missing. Existing indexes are
        left alone (qdrant raises a non-fatal error which we treat as
        success). Without indexes, payload filters degrade to a linear
        scan — fine at 100 docs, brutal at 10k."""
        for field, schema in _INDEXED_PAYLOAD_FIELDS.items():
            try:
                await self._client.create_payload_index(
                    collection_name=self._collection,
                    field_name=field,
                    field_schema=schema,
                )
            except Exception as e:
                # qdrant-client raises a generic exception on "already
                # exists" — accept it; log everything else.
                if "already exists" in str(e).lower():
                    continue
                log.warning(
                    "qdrant_payload_index_failed",
                    field=field,
                    error=str(e),
                )

    async def upsert_chunks(
        self,
        chunks: Iterable[Chunk],
        embeddings: Sequence[Sequence[float]],
        *,
        doc_id: int,
        doc_type: str | None = None,
        correspondent: str | None = None,
        tags: Sequence[str] = (),
        created_date: date | None = None,
    ) -> int:
        """Upsert the given (chunk, embedding) pairs for one document.

        Reuses the same point ID for each `(doc_id, chunk_index)` pair so
        re-running the indexer for a document replaces existing chunks
        in place rather than producing duplicates. Returns the number of
        points written.

        Empty input → zero. Mismatched lengths between `chunks` and
        `embeddings` is a programmer error and raises ValueError.
        """
        chunk_list = list(chunks)
        if len(chunk_list) != len(embeddings):
            raise ValueError(
                f"chunks ({len(chunk_list)}) and embeddings ({len(embeddings)}) "
                "must be the same length"
            )
        if not chunk_list:
            return 0

        points: list[models.PointStruct] = []
        for chunk, vec in zip(chunk_list, embeddings, strict=True):
            payload = ChunkPayload(
                doc_id=doc_id,
                chunk_index=chunk.index,
                text=chunk.text,
                char_start=chunk.char_start,
                char_end=chunk.char_end,
                token_count=chunk.token_count,
                doc_type=doc_type,
                correspondent=correspondent,
                tags=tuple(tags),
                created_date=created_date,
            )
            points.append(
                models.PointStruct(
                    id=_point_id(doc_id, chunk.index),
                    vector=list(vec),
                    payload=_payload_to_dict(payload),
                )
            )
        await self._client.upsert(
            collection_name=self._collection,
            points=points,
            wait=True,
        )
        return len(points)

    async def delete_by_doc_id(self, doc_id: int) -> None:
        """Remove every chunk belonging to `doc_id`. Used when a doc
        is reprocessed (lifecycle reset) so stale chunks don't haunt
        future searches. No-op if the doc isn't indexed."""
        await self._client.delete(
            collection_name=self._collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="doc_id",
                            match=models.MatchValue(value=doc_id),
                        )
                    ]
                )
            ),
            wait=True,
        )

    async def search(
        self,
        query_vector: Sequence[float],
        *,
        top_k: int = 50,
        filter: SearchFilter | None = None,
    ) -> list[SearchHit]:
        """Nearest-neighbour search with optional payload filtering.

        `top_k=50` is the recommended fan-out before reranker — higher
        than the answer LLM ever sees, but the reranker re-ranks
        cheaply enough that a wide first stage helps recall.
        """
        qdrant_filter = _build_qdrant_filter(filter) if filter else None
        # `query_points` is the modern (Qdrant 1.10+) name; older
        # `search` is deprecated. Use the new path so we're not on a
        # deprecation treadmill.
        result = await self._client.query_points(
            collection_name=self._collection,
            query=list(query_vector),
            limit=top_k,
            query_filter=qdrant_filter,
            with_payload=True,
        )
        return [
            SearchHit(score=p.score, payload=_payload_from_dict(p.payload or {}))
            for p in result.points
        ]

    async def health_check(self) -> bool:
        """Returns True if the collection exists and Qdrant is responsive.

        Used by the desktop shell's status panel and by the
        `/api/admin/index/status` endpoint (RAG Phase 1.8). Non-throwing
        — a failure becomes False so the caller can render a status
        indicator instead of an exception trace."""
        try:
            return await self._client.collection_exists(self._collection)
        except Exception as e:
            log.warning("qdrant_health_check_failed", error=str(e))
            return False


def _point_id(doc_id: int, chunk_index: int) -> str:
    """Deterministic UUID5 from (doc_id, chunk_index). Stable across
    re-indexing runs so upserts replace rather than duplicate."""
    return str(uuid.uuid5(_POINT_ID_NAMESPACE, f"{doc_id}:{chunk_index}"))


def _payload_to_dict(payload: ChunkPayload) -> dict[str, Any]:
    """Frozen-dataclass → plain dict for Qdrant's wire format. Stringify
    the date so JSON serialization is unambiguous; coerce the tags
    tuple to a list because Qdrant rejects tuples server-side."""
    return {
        "doc_id": payload.doc_id,
        "chunk_index": payload.chunk_index,
        "text": payload.text,
        "char_start": payload.char_start,
        "char_end": payload.char_end,
        "token_count": payload.token_count,
        "doc_type": payload.doc_type,
        "correspondent": payload.correspondent,
        "tags": list(payload.tags),
        "created_date": payload.created_date.isoformat() if payload.created_date else None,
        "page": payload.page,
    }


def _payload_from_dict(raw: dict[str, Any]) -> ChunkPayload:
    """Wire dict → ChunkPayload. Tolerates missing fields so older
    chunks in a long-lived collection don't break a fresh deploy."""
    created_raw = raw.get("created_date")
    created_date: date | None = None
    if isinstance(created_raw, str):
        try:
            created_date = date.fromisoformat(created_raw[:10])
        except ValueError:
            created_date = None
    elif isinstance(created_raw, datetime):
        created_date = created_raw.date()
    return ChunkPayload(
        doc_id=int(raw.get("doc_id", 0)),
        chunk_index=int(raw.get("chunk_index", 0)),
        text=str(raw.get("text", "")),
        char_start=int(raw.get("char_start", 0)),
        char_end=int(raw.get("char_end", 0)),
        token_count=int(raw.get("token_count", 0)),
        doc_type=raw.get("doc_type"),
        correspondent=raw.get("correspondent"),
        tags=tuple(raw.get("tags") or ()),
        created_date=created_date,
        page=raw.get("page"),
    )


def _build_qdrant_filter(f: SearchFilter) -> models.Filter:
    """Compose a `models.Filter` from our small `SearchFilter` shape.

    All conditions go into MUST, so different fields AND together; a
    single field with multiple values uses MatchAny so its values OR
    together (matching the SearchFilter docstring contract)."""
    must: list[models.Condition] = []
    if f.doc_ids:
        must.append(
            models.FieldCondition(
                key="doc_id",
                match=models.MatchAny(any=list(f.doc_ids)),
            )
        )
    if f.doc_types:
        must.append(
            models.FieldCondition(
                key="doc_type",
                match=models.MatchAny(any=list(f.doc_types)),
            )
        )
    if f.correspondents:
        must.append(
            models.FieldCondition(
                key="correspondent",
                match=models.MatchAny(any=list(f.correspondents)),
            )
        )
    if f.tags:
        must.append(
            models.FieldCondition(
                key="tags",
                match=models.MatchAny(any=list(f.tags)),
            )
        )
    return models.Filter(must=must)
