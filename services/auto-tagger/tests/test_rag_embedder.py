"""Unit tests for the RAG embedder.

The OllamaEmbedder takes a `client` injection point so tests don't need
to mock httpx or run a real Ollama server — we feed in a stub client
that records calls and returns scripted responses. This is the same
pattern the LLM backends use in production code.
"""

from __future__ import annotations

import pytest
from aktenraum_core.rag import Embedder, OllamaEmbedder


class _FakeOllamaClient:
    """Minimal stand-in for `ollama.AsyncClient`.

    Records every `embed` call and returns scripted responses. Raises
    if asked to handle anything other than `embed` so a misuse in
    production code surfaces as a test failure rather than silently
    succeeding against the wrong stub method.
    """

    def __init__(self, *, embeddings: list[list[float]]) -> None:
        self._embeddings = embeddings
        self.calls: list[dict] = []

    async def embed(self, *, model: str, input: list[str]) -> dict:
        self.calls.append({"model": model, "input": input})
        # Return only as many rows as the input demanded; any extras in
        # the scripted list are an explicit test setup error.
        if len(self._embeddings) < len(input):
            raise AssertionError(
                f"stub configured with {len(self._embeddings)} rows but "
                f"asked for {len(input)}"
            )
        return {"embeddings": self._embeddings[: len(input)]}


def _vec(prefix: float, *, dim: int = 2560) -> list[float]:
    """Build a deterministic vector for assertion. The first entry is the
    `prefix` value and the rest are zeros — easier to eyeball than
    actual embeddings while staying the right shape."""
    out = [0.0] * dim
    out[0] = prefix
    return out


# ---- happy path -----------------------------------------------------------


async def test_embed_dense_returns_one_vector_per_input():
    fake = _FakeOllamaClient(embeddings=[_vec(1.0), _vec(2.0), _vec(3.0)])
    embedder = OllamaEmbedder(base_url="http://x", client=fake)

    out = await embedder.embed_dense(["alpha", "beta", "gamma"])

    assert len(out) == 3
    assert out[0][0] == 1.0
    assert out[1][0] == 2.0
    assert out[2][0] == 3.0
    # Single batched call — no client-side mini-batching.
    assert len(fake.calls) == 1
    assert fake.calls[0]["model"] == "qwen3-embedding:4b"
    assert fake.calls[0]["input"] == ["alpha", "beta", "gamma"]


async def test_embed_dense_empty_input_short_circuits_without_upstream_call():
    """No client call when `texts` is empty — saves a round trip and
    keeps the function trivially callable inside a loop."""
    fake = _FakeOllamaClient(embeddings=[])
    embedder = OllamaEmbedder(base_url="http://x", client=fake)

    out = await embedder.embed_dense([])

    assert out == []
    assert fake.calls == []


async def test_embed_dense_returns_fresh_lists_not_upstream_references():
    """Coerce upstream types into plain `list[float]` so callers can
    mutate / cache without affecting the library's response object."""
    upstream_vec = _vec(1.0)
    fake = _FakeOllamaClient(embeddings=[upstream_vec])
    embedder = OllamaEmbedder(base_url="http://x", client=fake)

    out = await embedder.embed_dense(["alpha"])

    out[0][0] = 99.0
    assert upstream_vec[0] == 1.0, (
        "OllamaEmbedder must return a fresh list — caller mutation "
        "leaked back into the stub's data"
    )


# ---- model + dim properties ----------------------------------------------


async def test_default_model_is_qwen3_embedding():
    embedder = OllamaEmbedder(base_url="http://x", client=_FakeOllamaClient(embeddings=[]))
    assert embedder.model == "qwen3-embedding:4b"


async def test_model_override_passed_through_to_upstream():
    fake = _FakeOllamaClient(embeddings=[_vec(0.0)])
    embedder = OllamaEmbedder(
        base_url="http://x", model="nomic-embed-text", client=fake
    )

    await embedder.embed_dense(["hello"])

    assert fake.calls[0]["model"] == "nomic-embed-text"


async def test_dense_dim_matches_configured_constant():
    embedder = OllamaEmbedder(base_url="http://x", client=_FakeOllamaClient(embeddings=[]))
    assert embedder.dense_dim == 2560


# ---- error propagation ---------------------------------------------------


async def test_upstream_exception_propagates():
    """Embedding failures must NOT be swallowed — the indexing worker
    needs to see them so it can tag `ai-index-error` and skip the doc."""

    class _ExplodingClient:
        async def embed(self, *, model: str, input: list[str]) -> dict:
            raise RuntimeError("ollama unreachable")

    embedder = OllamaEmbedder(base_url="http://x", client=_ExplodingClient())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="ollama unreachable"):
        await embedder.embed_dense(["alpha"])


# ---- protocol conformance ------------------------------------------------


async def test_ollama_embedder_satisfies_embedder_protocol():
    """Runtime-check that the production class implements the Protocol —
    catches accidental signature drift between Embedder and OllamaEmbedder
    that mypy would flag but plain pytest wouldn't."""
    embedder = OllamaEmbedder(base_url="http://x", client=_FakeOllamaClient(embeddings=[]))
    assert isinstance(embedder, Embedder)
