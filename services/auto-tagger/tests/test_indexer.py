"""Unit tests for the RAG indexer worker (Phase 1.5).

The indexer composes three collaborators (PaperlessClient, Embedder,
QdrantVectorStore) into one coroutine. Tests inject stubs for all
three and assert the orchestration: re-fetch the doc, fetch content,
chunk, embed, delete-old, upsert, on-error tag. No live Paperless,
Ollama, or Qdrant needed.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from aktenraum_core.rag import Chunk

from auto_tagger.indexer import (
    INDEX_ERROR_TAG,
    IndexingDeps,
    _filter_user_tags,
    index_document,
)


def _doc(
    doc_id: int = 17,
    *,
    content: str | None = None,
    tags: list[int] | None = None,
    correspondent: int | None = None,
    document_type: int | None = None,
    created_date: str = "2024-02-15",
) -> dict[str, Any]:
    """Minimal Paperless-shaped doc dict."""
    return {
        "id": doc_id,
        "content": content,
        "tags": tags or [],
        "correspondent": correspondent,
        "document_type": document_type,
        "created_date": created_date,
        "custom_fields": [],
    }


def _make_paperless(
    *,
    doc: dict[str, Any],
    correspondents: dict[int, str] | None = None,
    document_types: dict[int, str] | None = None,
    tags_map: dict[int, str] | None = None,
    ai_fields: dict[str, Any] | None = None,
    content: str = "",
) -> AsyncMock:
    """Build an AsyncMock that mimics the PaperlessClient surface the
    indexer touches. Returning sensible defaults from each method
    keeps the test bodies short."""
    paperless = AsyncMock()
    paperless.get_document = AsyncMock(return_value=doc)
    paperless.get_document_content = AsyncMock(return_value=content)

    async def _entity_map(endpoint: str) -> dict[int, str]:
        if "correspondent" in endpoint:
            return correspondents or {}
        if "document_type" in endpoint:
            return document_types or {}
        if "tags" in endpoint:
            return tags_map or {}
        return {}

    paperless.get_entity_name_map = AsyncMock(side_effect=_entity_map)
    paperless.get_ai_custom_field_values = AsyncMock(
        return_value=ai_fields or {}
    )
    paperless.get_or_create_tag = AsyncMock(return_value=999)
    paperless._get_tag_id = AsyncMock(return_value=None)
    paperless.patch_document_native_fields = AsyncMock()
    return paperless


def _make_embedder(*, dim: int = 4) -> MagicMock:
    """Embedder returning a deterministic vector per input — first
    component records the input length so tests can correlate hits
    back to inputs."""
    embedder = MagicMock()

    async def _embed(texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            v = [0.0] * dim
            v[0] = float(len(t))
            out.append(v)
        return out

    embedder.embed_dense = AsyncMock(side_effect=_embed)
    embedder.dense_dim = dim
    embedder.model = "qwen3-embedding:4b"
    return embedder


def _make_vector_store() -> MagicMock:
    store = MagicMock()
    store.delete_by_doc_id = AsyncMock()
    store.upsert_chunks = AsyncMock(return_value=0)
    store.ensure_collection = AsyncMock()
    return store


# ---- happy path -----------------------------------------------------------


async def test_index_document_chunks_embeds_and_upserts():
    """End-to-end happy path: fetch doc → chunk content → embed →
    delete old chunks → upsert new chunks. Assert the upsert call
    carries the right payload (denormalised metadata)."""
    doc = _doc(
        doc_id=42,
        content="Erster Absatz mit ein paar Worten.\n\nZweiter Absatz, ebenso kurz.",
        tags=[1, 2, 3],  # 3 = lifecycle (excluded), 1 + 2 = user tags
        correspondent=10,
        document_type=20,
    )
    paperless = _make_paperless(
        doc=doc,
        correspondents={10: "Telekom"},
        document_types={20: "Rechnung"},
        tags_map={
            1: "Mobilfunk",
            2: "Wichtig",
            3: "ai-propagated",  # lifecycle — must NOT appear in payload
        },
    )
    embedder = _make_embedder()
    vector_store = _make_vector_store()
    deps = IndexingDeps(
        paperless=paperless, embedder=embedder, vector_store=vector_store
    )

    await index_document(42, deps)

    # Always delete-by-doc before upsert (idempotent re-index).
    vector_store.delete_by_doc_id.assert_awaited_once_with(42)

    # Embedder was given the chunked text in one batched call.
    embedder.embed_dense.assert_awaited_once()
    chunked_texts = embedder.embed_dense.await_args.args[0]
    assert len(chunked_texts) >= 1

    # Upsert payload denormalises the doc's metadata onto every chunk.
    vector_store.upsert_chunks.assert_awaited_once()
    kwargs = vector_store.upsert_chunks.await_args.kwargs
    assert kwargs["doc_id"] == 42
    assert kwargs["doc_type"] == "Rechnung"
    assert kwargs["correspondent"] == "Telekom"
    assert tuple(kwargs["tags"]) == ("Mobilfunk", "Wichtig")
    assert kwargs["created_date"] == date(2024, 2, 15)


async def test_index_document_falls_back_to_ai_fields_when_native_fk_missing():
    """When a doc has no native correspondent/document_type FK, payload
    should fall back to the AI custom-field values (legacy docs,
    rejected propagations)."""
    doc = _doc(doc_id=42, content="Ein kurzer Inhalt ohne native FKs.")
    paperless = _make_paperless(
        doc=doc,
        ai_fields={
            "ai_correspondent": "Stadtwerke",
            "ai_document_type": "Rechnung",
        },
    )
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(42, deps)

    kwargs = deps.vector_store.upsert_chunks.await_args.kwargs
    assert kwargs["correspondent"] == "Stadtwerke"
    assert kwargs["doc_type"] == "Rechnung"


async def test_index_document_uses_get_document_content_when_inline_empty():
    """If the doc dict's `content` field is missing, fetch via the
    dedicated content endpoint."""
    doc = _doc(content=None)
    paperless = _make_paperless(doc=doc, content="Inhalt aus dem /content/ Endpoint.")
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    paperless.get_document_content.assert_awaited_once_with(17)
    deps.vector_store.upsert_chunks.assert_awaited_once()


# ---- empty / degenerate inputs --------------------------------------------


async def test_index_document_empty_content_still_clears_old_chunks():
    """A reprocess that produced no content (e.g. a corrupt PDF) must
    still delete any prior chunks for that doc — leaving stale entries
    would silently corrupt search."""
    doc = _doc(content="")
    paperless = _make_paperless(doc=doc, content="")
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    deps.vector_store.delete_by_doc_id.assert_awaited_once_with(17)
    # No chunks → no embed call.
    deps.embedder.embed_dense.assert_not_awaited()
    # No upsert when there are no chunks.
    deps.vector_store.upsert_chunks.assert_not_awaited()


async def test_index_document_chunks_capped_to_max():
    """Cap is enforced so a runaway OCR result can't DoS the embedder.

    The chunker packs small paragraphs greedily into chunks up to its
    500-token target, so naive small paragraphs collapse into a few
    chunks. To force one-chunk-per-paragraph (and thus exceed the
    cap), each paragraph here is itself 600+ tokens with no sentence
    boundaries — the chunker can't sub-split it and emits one chunk per.
    """
    # 300 paragraphs of 600 fake-word tokens each. No `[.!?]` so the
    # sentence fallback finds no boundary and keeps the paragraph whole.
    big_para = " ".join(f"wort{i}" for i in range(600))
    content = "\n\n".join([big_para] * 300)
    doc = _doc(content=content)
    paperless = _make_paperless(doc=doc)
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    chunked_texts = deps.embedder.embed_dense.await_args.args[0]
    # 300 paragraphs would produce 300 chunks; the cap drops it to 200.
    assert len(chunked_texts) == 200


# ---- failure paths --------------------------------------------------------


async def test_index_document_swallows_fetch_error():
    """A get_document failure (Paperless restart, network blip) must
    NOT crash the indexer worker — it logs and returns, the next
    enqueue gets a fresh chance."""
    paperless = AsyncMock()
    paperless.get_document = AsyncMock(side_effect=RuntimeError("paperless down"))
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    # Must not raise.
    await index_document(17, deps)

    deps.vector_store.delete_by_doc_id.assert_not_awaited()
    deps.vector_store.upsert_chunks.assert_not_awaited()


async def test_index_document_tags_index_error_on_qdrant_failure():
    """When the upsert blows up (Qdrant unreachable, schema mismatch),
    we tag the doc `ai-index-error` so the SPA can surface the failure
    and the user can retry. The exception itself is swallowed."""
    doc = _doc(content="ein Inhalt der gechunked wird")
    paperless = _make_paperless(doc=doc)
    embedder = _make_embedder()
    vector_store = _make_vector_store()
    vector_store.upsert_chunks = AsyncMock(side_effect=RuntimeError("qdrant unreachable"))
    deps = IndexingDeps(
        paperless=paperless, embedder=embedder, vector_store=vector_store
    )

    await index_document(17, deps)

    paperless.get_or_create_tag.assert_awaited_with(INDEX_ERROR_TAG)
    paperless.patch_document_native_fields.assert_awaited()
    patch_kwargs = paperless.patch_document_native_fields.await_args.kwargs
    assert 999 in patch_kwargs["tags"]  # 999 is the stub's tag id


async def test_index_document_tag_failure_is_swallowed():
    """If even the error-tag PATCH fails (truly broken paperless), the
    indexer logs and returns rather than crashing the worker loop."""
    doc = _doc(content="x")
    paperless = _make_paperless(doc=doc)
    paperless.patch_document_native_fields = AsyncMock(side_effect=RuntimeError("dead"))
    embedder = _make_embedder()
    vector_store = _make_vector_store()
    vector_store.upsert_chunks = AsyncMock(side_effect=RuntimeError("qdrant unreachable"))
    deps = IndexingDeps(
        paperless=paperless, embedder=embedder, vector_store=vector_store
    )

    await index_document(17, deps)  # must not raise


# ---- success self-heal ---------------------------------------------------


async def test_index_document_clears_existing_index_error_tag_on_success():
    """When a doc previously had `ai-index-error` (the indexer is
    retrying after a recovery), a successful index must remove the
    tag so the SPA stops showing the error pill."""
    doc = _doc(doc_id=17, content="hello world", tags=[55])
    paperless = _make_paperless(doc=doc, tags_map={55: INDEX_ERROR_TAG})
    paperless._get_tag_id = AsyncMock(return_value=55)
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    paperless.patch_document_native_fields.assert_awaited()
    patch_kwargs = paperless.patch_document_native_fields.await_args.kwargs
    assert 55 not in patch_kwargs["tags"]


async def test_index_document_does_not_patch_when_no_index_error_tag_present():
    """If there's nothing to clear, no PATCH happens — avoids spamming
    Paperless with no-op writes on every successful re-index."""
    doc = _doc(doc_id=17, content="hello world", tags=[1])
    paperless = _make_paperless(doc=doc, tags_map={1: "some-user-tag"})
    paperless._get_tag_id = AsyncMock(return_value=None)
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    paperless.patch_document_native_fields.assert_not_awaited()


# ---- _filter_user_tags ----------------------------------------------------


def test_filter_user_tags_excludes_lifecycle_and_aux():
    """The pure tag filter is the source of truth for what gets into
    the searchable Qdrant payload — lifecycle tags and the
    `ai-low-confidence` / `ai-index-error` auxiliaries must never
    appear there. Pinning the contract here so a future tag-vocab
    change has to opt-in to surfacing internal flags."""
    out = _filter_user_tags(
        [1, 2, 3, 4, 5, 6, 7, 8],
        {
            1: "Mobilfunk",
            2: "ai-pending",
            3: "ai-approved",
            4: "ai-rejected",
            5: "ai-propagated",
            6: "Wichtig",
            7: "ai-low-confidence",
            8: "ai-index-error",
        },
    )
    assert sorted(out) == ["Mobilfunk", "Wichtig"]


def test_filter_user_tags_drops_unknown_ids():
    """A tag id with no entry in the resolved map is dropped silently
    — better an incomplete payload than a crash on a stale tag map."""
    out = _filter_user_tags([1, 99], {1: "Visible"})
    assert out == ["Visible"]


# ---- chunker integration --------------------------------------------------


async def test_indexer_passes_chunk_objects_to_vector_store():
    """Sanity: the indexer hands `Chunk` instances (not raw strings) to
    the vector store so payload offsets are accurate."""
    doc = _doc(content="alpha beta gamma delta")
    paperless = _make_paperless(doc=doc)
    deps = IndexingDeps(
        paperless=paperless,
        embedder=_make_embedder(),
        vector_store=_make_vector_store(),
    )

    await index_document(17, deps)

    chunks_passed = deps.vector_store.upsert_chunks.await_args.kwargs["chunks"]
    assert all(isinstance(c, Chunk) for c in chunks_passed)
