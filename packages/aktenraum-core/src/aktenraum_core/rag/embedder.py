"""Embedding backend for the RAG indexing pipeline.

Today this module ships dense-only embeddings via Ollama's `/api/embed`
endpoint, using Qwen3-Embedding-4B (2560-dim) by default. Ollama does
not expose sparse / SPLADE-style output for any embedding model, so the
retrieval stack is dense-only; the `Embedder` Protocol is written so a
hybrid (dense + sparse) implementation can be added later without
breaking the indexing or query-time call sites. See
`docs/plans/rag-phase-1.md` for the original bge-m3 hybrid design that
this dense-only path descends from.

Design choices worth flagging:

- We use `ollama.AsyncClient` rather than raw httpx because the LLM
  backends already depend on it (`ollama_backend.py`); reusing the
  same client library keeps the docker image lean and the connection
  pooling consistent.
- Dense dimension is a per-class constant rather than a runtime
  query of the model. Ollama's `/api/show` does expose this, but
  swapping the embedding model requires rebuilding the Qdrant
  collection anyway (vectors of different dims can't coexist), so a
  hardcoded constant matches operational reality.
- Empty input is handled client-side (no upstream call). Ollama
  itself accepts empty `input` and returns an empty list; short-
  circuiting saves a round-trip and makes the function trivially
  callable in a loop without guards at every call site.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import ollama
import structlog

log = structlog.get_logger()


# Dense vector dimension of the configured embedding model
# (Qwen3-Embedding-4B → 2560). The Qdrant collection is created against
# this value, so it is the single source of truth: `QdrantVectorStore`
# imports it as its default `dense_dim`. Switching to a model with a
# different dimension requires deleting and recreating the collection
# (vectors of different dims can't coexist) plus a full re-index — keep
# this in lockstep with the model named in `EMBEDDING_MODEL` / the
# `OllamaEmbedder` default below.
DENSE_DIM = 2560


@runtime_checkable
class Embedder(Protocol):
    """Pluggable embedding backend used by the indexing and query paths.

    Today only `embed_dense` is required. When sparse-vector support
    lands (either Ollama exposes it or we run a `transformers` sidecar),
    extend this Protocol with `embed_sparse(texts) -> list[dict[int, float]]`
    — a SPLADE-like sparse vector is a `{token_id: weight}` map.
    """

    async def embed_dense(self, texts: list[str]) -> list[list[float]]: ...

    @property
    def dense_dim(self) -> int: ...

    @property
    def model(self) -> str: ...


class OllamaEmbedder:
    """Ollama-backed dense embedder targeting `qwen3-embedding:4b` by default.

    Wraps `ollama.AsyncClient.embed` for batched dense embeddings.
    Ollama internally batches the input list in a single inference
    pass, so we don't add a client-side mini-batching loop — feeding
    the whole batch through is faster than splitting it.

    The optional `client` parameter is a dependency-injection seam
    used by the test suite to feed in a fake; in production callers
    pass `base_url` and let the constructor build the real client.
    """

    def __init__(
        self,
        base_url: str,
        model: str = "qwen3-embedding:4b",
        *,
        client: ollama.AsyncClient | None = None,
    ) -> None:
        self._client = client or ollama.AsyncClient(host=base_url)
        self._model = model

    @property
    def name(self) -> str:
        return "ollama"

    @property
    def model(self) -> str:
        return self._model

    @property
    def dense_dim(self) -> int:
        return DENSE_DIM

    async def embed_dense(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts. Returns one dense vector per input
        in the same order. Empty input → empty output (no upstream call).

        Raises whatever the Ollama client raises on transport / 5xx
        errors; the caller (indexing worker) is expected to retry or
        surface as an `ai-index-error` lifecycle tag. We deliberately
        don't catch here — silently swallowing embedding failures
        would produce a doc that's "indexed" but invisible to search.
        """
        if not texts:
            return []
        response = await self._client.embed(model=self._model, input=texts)
        # The ollama-python typed response is a TypedDict-ish object;
        # `embeddings` is `list[list[float]]`. Coerce to a fresh list
        # so callers get a stable concrete type they can mutate / cache
        # without affecting the upstream library's response shape.
        return [list(vec) for vec in response["embeddings"]]
