"""Unit tests for QdrantVectorStore.

Tests inject a stub client that records calls and returns scripted
responses, mirroring the pattern used by `test_rag_embedder.py`. We
don't run a real Qdrant container — that's an integration concern we
address once 1.4 ships the compose service. The contract being tested
here is the wrapper's behaviour given a hypothetical Qdrant: that we
build the right filters, write the right payloads, dedupe by point ID,
and parse responses back into `ChunkPayload` correctly.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from aktenraum_core.rag import (
    Chunk,
    ChunkPayload,
    QdrantVectorStore,
    SearchFilter,
    SearchHit,
)
from aktenraum_core.rag.vector_store import (
    _build_qdrant_filter,
    _payload_from_dict,
    _payload_to_dict,
    _point_id,
)
from qdrant_client import models


class _FakeQdrantClient:
    """Stand-in for `AsyncQdrantClient` recording every call.

    Each method matches the wrapper's usage exactly. Methods that have
    multiple-version signatures (`close` vs `aclose`) expose the
    flavour the wrapper expects; tests that exercise the multi-version
    path stub them out individually.
    """

    def __init__(
        self,
        *,
        collection_exists: bool = False,
        search_points: list[models.ScoredPoint] | None = None,
        chunk_count: int = 0,
    ) -> None:
        self._collection_exists = collection_exists
        self._search_points = search_points or []
        self._chunk_count = chunk_count
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def collection_exists(self, name: str) -> bool:
        self.calls.append(("collection_exists", {"name": name}))
        return self._collection_exists

    async def create_collection(self, **kwargs: Any) -> None:
        self.calls.append(("create_collection", kwargs))
        # Mark the collection as existing so subsequent calls in the
        # same test don't re-create it — matches real Qdrant behaviour.
        self._collection_exists = True

    async def create_payload_index(self, **kwargs: Any) -> None:
        self.calls.append(("create_payload_index", kwargs))

    async def upsert(self, **kwargs: Any) -> None:
        self.calls.append(("upsert", kwargs))

    async def delete(self, **kwargs: Any) -> None:
        self.calls.append(("delete", kwargs))

    async def count(self, **kwargs: Any) -> Any:
        self.calls.append(("count", kwargs))

        class _CountResult:
            count = 0

        result = _CountResult()
        result.count = self._chunk_count
        return result

    async def query_points(self, **kwargs: Any) -> Any:
        self.calls.append(("query_points", kwargs))

        class _Response:
            pass

        resp = _Response()
        resp.points = self._search_points  # type: ignore[attr-defined]
        return resp


def _make_store(client: _FakeQdrantClient | None = None) -> QdrantVectorStore:
    """Construct a store wrapping the supplied stub. Real `url` is
    irrelevant because the stub never opens a connection."""
    return QdrantVectorStore(
        url="http://stub", client=client or _FakeQdrantClient()  # type: ignore[arg-type]
    )


# ---- ensure_collection ----------------------------------------------------


async def test_ensure_collection_creates_when_missing():
    fake = _FakeQdrantClient(collection_exists=False)
    store = _make_store(fake)

    await store.ensure_collection()

    method_names = [c[0] for c in fake.calls]
    # Must check for existence first, then create, then attempt indexes.
    assert method_names[0] == "collection_exists"
    assert "create_collection" in method_names
    create_kwargs = next(c[1] for c in fake.calls if c[0] == "create_collection")
    assert create_kwargs["collection_name"] == "aktenraum_chunks"
    vectors_config = create_kwargs["vectors_config"]
    assert vectors_config.size == 2560
    assert vectors_config.distance == models.Distance.COSINE


async def test_ensure_collection_skips_create_when_already_exists():
    fake = _FakeQdrantClient(collection_exists=True)
    store = _make_store(fake)

    await store.ensure_collection()

    method_names = [c[0] for c in fake.calls]
    assert "create_collection" not in method_names
    # Payload-index calls still happen — they're idempotent and self-heal
    # if a previous deploy added a new index field.
    assert any(c[0] == "create_payload_index" for c in fake.calls)


async def test_ensure_collection_creates_indexes_for_filterable_fields():
    fake = _FakeQdrantClient(collection_exists=True)
    store = _make_store(fake)

    await store.ensure_collection()

    indexed_fields = {
        c[1]["field_name"] for c in fake.calls if c[0] == "create_payload_index"
    }
    # The four fields the query path filters on.
    assert indexed_fields == {"doc_id", "doc_type", "correspondent", "tags"}


async def test_ensure_payload_indexes_swallows_already_exists():
    """Re-running ensure_collection on an already-indexed collection
    must not raise — Qdrant returns an 'already exists' error which the
    wrapper treats as success."""

    class _AlreadyExistsClient(_FakeQdrantClient):
        async def create_payload_index(self, **kwargs: Any) -> None:
            self.calls.append(("create_payload_index", kwargs))
            raise RuntimeError("Index for field doc_id already exists")

    fake = _AlreadyExistsClient(collection_exists=True)
    store = _make_store(fake)

    # Must not raise.
    await store.ensure_collection()


# ---- upsert_chunks --------------------------------------------------------


def _chunk(idx: int, text: str = "alpha beta gamma") -> Chunk:
    return Chunk(
        index=idx,
        text=text,
        char_start=idx * 100,
        char_end=idx * 100 + len(text),
        token_count=len(text.split()),
    )


async def test_upsert_chunks_writes_one_point_per_chunk():
    fake = _FakeQdrantClient()
    store = _make_store(fake)

    written = await store.upsert_chunks(
        chunks=[_chunk(0), _chunk(1), _chunk(2)],
        embeddings=[[0.0] * 2560, [1.0] * 2560, [2.0] * 2560],
        doc_id=42,
        doc_type="Lebenslauf",
        correspondent="Selbst",
        tags=["Lebenslauf", "Bewerbung"],
        created_date=date(2024, 1, 15),
    )

    assert written == 3
    upsert_kwargs = next(c[1] for c in fake.calls if c[0] == "upsert")
    points = upsert_kwargs["points"]
    assert len(points) == 3
    # Payload denormalises doc-level metadata onto every chunk so
    # query-time filters can apply at the vector layer.
    assert points[0].payload["doc_id"] == 42
    assert points[0].payload["doc_type"] == "Lebenslauf"
    assert points[0].payload["correspondent"] == "Selbst"
    assert points[0].payload["tags"] == ["Lebenslauf", "Bewerbung"]
    assert points[0].payload["created_date"] == "2024-01-15"
    # The chunk's text is in the payload — no second-fetch needed at
    # query time for the answer LLM.
    assert points[0].payload["text"] == "alpha beta gamma"


async def test_upsert_chunks_uses_deterministic_point_ids():
    """Same (doc_id, chunk_index) → same UUID, every run. Critical for
    idempotent re-indexing: a reprocess must REPLACE existing chunks,
    not append duplicates."""
    fake = _FakeQdrantClient()
    store = _make_store(fake)

    await store.upsert_chunks(
        chunks=[_chunk(7)],
        embeddings=[[0.0] * 2560],
        doc_id=99,
    )
    first_id = fake.calls[-1][1]["points"][0].id

    fake.calls.clear()
    await store.upsert_chunks(
        chunks=[_chunk(7)],
        embeddings=[[0.0] * 2560],
        doc_id=99,
    )
    second_id = fake.calls[-1][1]["points"][0].id

    assert first_id == second_id


async def test_upsert_chunks_empty_input_is_a_noop():
    fake = _FakeQdrantClient()
    store = _make_store(fake)

    written = await store.upsert_chunks(
        chunks=[], embeddings=[], doc_id=1
    )

    assert written == 0
    assert not any(c[0] == "upsert" for c in fake.calls)


async def test_upsert_chunks_mismatched_lengths_raises():
    """Programmer error — we surface it loudly rather than silently
    truncating one or the other."""
    store = _make_store()
    with pytest.raises(ValueError, match="must be the same length"):
        await store.upsert_chunks(
            chunks=[_chunk(0)], embeddings=[[0.0] * 2560, [1.0] * 2560], doc_id=1
        )


# ---- delete_by_doc_id -----------------------------------------------------


async def test_delete_by_doc_id_filters_on_doc_id():
    fake = _FakeQdrantClient()
    store = _make_store(fake)

    await store.delete_by_doc_id(42)

    delete_kwargs = next(c[1] for c in fake.calls if c[0] == "delete")
    selector = delete_kwargs["points_selector"]
    # The filter MUST clause matches exactly one doc_id.
    must = selector.filter.must
    assert len(must) == 1
    assert must[0].key == "doc_id"
    assert must[0].match.value == 42


# ---- search ---------------------------------------------------------------


def _scored_point(score: float, payload: dict[str, Any]) -> models.ScoredPoint:
    return models.ScoredPoint(
        id="dummy",
        version=0,
        score=score,
        payload=payload,
        vector=None,
    )


async def test_search_passes_through_filter_and_top_k():
    fake = _FakeQdrantClient(
        search_points=[
            _scored_point(
                0.95,
                {
                    "doc_id": 17,
                    "chunk_index": 3,
                    "text": "Frontend bei Kopfstand seit 2022.",
                    "char_start": 0,
                    "char_end": 30,
                    "token_count": 5,
                    "doc_type": "Lebenslauf",
                    "correspondent": "Selbst",
                    "tags": ["Lebenslauf"],
                    "created_date": "2024-01-15",
                    "page": None,
                },
            )
        ]
    )
    store = _make_store(fake)

    hits = await store.search(
        query_vector=[0.5] * 2560,
        top_k=10,
        filter=SearchFilter(tags=["Lebenslauf"], doc_types=["Lebenslauf"]),
    )

    query_kwargs = next(c[1] for c in fake.calls if c[0] == "query_points")
    assert query_kwargs["limit"] == 10
    # The composed filter has two MUST conditions (doc_type, tags).
    qfilter = query_kwargs["query_filter"]
    keys = [c.key for c in qfilter.must]
    assert "doc_type" in keys
    assert "tags" in keys
    # Hits are projected back into our typed shape.
    assert len(hits) == 1
    assert hits[0].score == 0.95
    assert hits[0].payload.doc_id == 17
    assert hits[0].payload.text == "Frontend bei Kopfstand seit 2022."


async def test_search_without_filter_omits_query_filter():
    fake = _FakeQdrantClient(search_points=[])
    store = _make_store(fake)

    await store.search(query_vector=[0.0] * 2560, top_k=5)

    query_kwargs = next(c[1] for c in fake.calls if c[0] == "query_points")
    assert query_kwargs["query_filter"] is None


# ---- health_check ---------------------------------------------------------


async def test_count_chunks_for_doc_filters_on_doc_id():
    """Backfill needs a cheap "is this doc indexed?" probe — we use
    Qdrant's count API with a doc_id filter. Pin the filter shape so
    a refactor can't silently change the where clause."""
    fake = _FakeQdrantClient(chunk_count=7)
    store = _make_store(fake)

    count = await store.count_chunks_for_doc(42)

    assert count == 7
    count_kwargs = next(c[1] for c in fake.calls if c[0] == "count")
    assert count_kwargs["collection_name"] == "aktenraum_chunks"
    assert count_kwargs["exact"] is True
    must = count_kwargs["count_filter"].must
    assert len(must) == 1
    assert must[0].key == "doc_id"
    assert must[0].match.value == 42


async def test_count_chunks_for_doc_returns_zero_when_doc_not_indexed():
    fake = _FakeQdrantClient(chunk_count=0)
    store = _make_store(fake)
    assert await store.count_chunks_for_doc(99) == 0


async def test_health_check_true_when_collection_exists():
    store = _make_store(_FakeQdrantClient(collection_exists=True))
    assert await store.health_check() is True


async def test_health_check_false_on_exception():
    """Health checks must not raise — the desktop shell renders status
    indicators, not stack traces."""

    class _ExplodingClient:
        async def collection_exists(self, name: str) -> bool:
            raise RuntimeError("connection refused")

    store = _make_store(_ExplodingClient())  # type: ignore[arg-type]
    assert await store.health_check() is False


# ---- internal helpers -----------------------------------------------------


def test_point_id_is_deterministic_per_doc_chunk_pair():
    a = _point_id(99, 0)
    b = _point_id(99, 0)
    c = _point_id(99, 1)
    assert a == b
    assert a != c


def test_point_id_namespace_pinned():
    """Sentinel: regenerating the namespace UUID would orphan every
    existing chunk in production. This test fails fast if someone
    regenerates the constant by mistake."""
    # Hardcoded against the namespace UUID frozen in
    # vector_store._POINT_ID_NAMESPACE. If this assertion fails, someone
    # regenerated the namespace — every chunk in any deployed Qdrant
    # collection would be orphaned.
    expected = "9c9fc3cd-97ef-5de0-ae76-d3dfee216087"
    assert _point_id(0, 0) == expected, (
        "Point-ID namespace appears to have changed. Every existing chunk "
        "in any deployed Qdrant collection would be orphaned."
    )


def test_payload_round_trip_preserves_fields():
    p = ChunkPayload(
        doc_id=42,
        chunk_index=3,
        text="hello",
        char_start=0,
        char_end=5,
        token_count=1,
        doc_type="Rechnung",
        correspondent="Telekom",
        tags=("Telekom", "Mobilfunk"),
        created_date=date(2024, 6, 15),
        page=2,
    )
    raw = _payload_to_dict(p)
    restored = _payload_from_dict(raw)
    assert restored == p


def test_payload_from_dict_tolerates_missing_fields():
    """Long-lived collections may have older chunks written with a
    smaller schema. Decoding must not blow up."""
    restored = _payload_from_dict({"doc_id": 1, "chunk_index": 0, "text": "x"})
    assert restored.doc_id == 1
    assert restored.tags == ()
    assert restored.created_date is None


def test_payload_to_dict_normalises_tag_tuple_to_list():
    """Qdrant rejects tuples server-side — they have to be JSON arrays."""
    p = ChunkPayload(
        doc_id=1,
        chunk_index=0,
        text="x",
        char_start=0,
        char_end=1,
        token_count=1,
        tags=("a", "b"),
    )
    raw = _payload_to_dict(p)
    assert isinstance(raw["tags"], list)


def test_build_qdrant_filter_combines_fields_with_must():
    f = SearchFilter(
        doc_types=["Rechnung"],
        correspondents=["Telekom"],
        tags=["wichtig"],
    )
    qfilter = _build_qdrant_filter(f)
    keys = [c.key for c in qfilter.must]
    assert keys == ["doc_type", "correspondent", "tags"]


def test_build_qdrant_filter_uses_match_any_within_a_field():
    """Multiple values in one field OR together (MatchAny); different
    fields AND together (MUST). Test the OR side here."""
    f = SearchFilter(tags=["Lebenslauf", "Bewerbung"])
    qfilter = _build_qdrant_filter(f)
    cond = qfilter.must[0]
    assert isinstance(cond.match, models.MatchAny)
    assert cond.match.any == ["Lebenslauf", "Bewerbung"]


def test_search_hit_dataclass_is_frozen():
    """Search results travel through the answer pipeline; freezing
    prevents accidental mutation downstream."""
    hit = SearchHit(
        score=0.5,
        payload=ChunkPayload(
            doc_id=1,
            chunk_index=0,
            text="x",
            char_start=0,
            char_end=1,
            token_count=1,
        ),
    )
    with pytest.raises(Exception):  # noqa: BLE001 — FrozenInstanceError
        hit.score = 0.6  # type: ignore[misc]
