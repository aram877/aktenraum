"""RAG primitives: chunking, embedding, vector storage, reranking.

The modules here are pure-where-possible building blocks for the local
retrieval stack defined in `docs/plans/rag-phase-1.md`. Higher-level
orchestration (indexing pipeline, query-time hybrid retrieval) lives in
the consuming services (`auto-tagger`, `aktenraum-api`) — this package
stays I/O-light so individual pieces stay independently testable.
"""

from .chunker import Chunk, chunk_text
from .embedder import Embedder, OllamaEmbedder
from .vector_store import (
    ChunkPayload,
    QdrantVectorStore,
    SearchFilter,
    SearchHit,
)

__all__ = [
    "Chunk",
    "ChunkPayload",
    "Embedder",
    "OllamaEmbedder",
    "QdrantVectorStore",
    "SearchFilter",
    "SearchHit",
    "chunk_text",
]
