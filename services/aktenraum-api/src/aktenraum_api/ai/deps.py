from __future__ import annotations

from aktenraum_core.llm import LLMBackend, create_backend
from aktenraum_core.rag import QdrantVectorStore
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_settings
from ..config import Settings
from ..db.session import get_session
from ..paperless_gw import PaperlessGateway
from ..settings import service as settings_service
from .retrieval import RetrievalDeps


def get_vector_store_optional(request: Request) -> QdrantVectorStore | None:
    """Return the per-process Qdrant vector store, or None when RAG is
    disabled (`QDRANT_URL` unset, or Qdrant unreachable at boot).

    Callers that need to mutate the index (e.g. the trash service's
    hard-delete path) treat `None` as a no-op so RAG-off installs
    continue to work without branching on every call site.
    """
    return getattr(request.app.state, "rag_vector_store", None)


def get_retrieval_deps(request: Request) -> RetrievalDeps | None:
    """Return the per-process RAG retrieval deps, or None if disabled.

    The deps are constructed once during lifespan startup (in main.py)
    when QDRANT_URL is configured — building a fresh embedder + vector
    store + reranker per request would re-pay the bge-reranker
    600 MB load every time. None means RAG is disabled; calling
    endpoints fall back to their structural-only path.
    """
    return getattr(request.app.state, "retrieval_deps", None)


def get_paperless_gateway(request: Request) -> PaperlessGateway:
    gateway: PaperlessGateway | None = getattr(
        request.app.state, "paperless_gateway", None
    )
    if gateway is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paperless API token not configured",
        )
    return gateway


async def get_llm_backend(
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> LLMBackend:
    """Build a fresh backend per request for the default (filter) model.

    When LLM_BACKEND=ollama, the actual model name is read from the
    app_settings row (set via the Settings page) so the operator can flip
    quality without recreating containers. Anthropic still reads ANTHROPIC_MODEL
    from the env — that backend isn't tied to the local quality picker.
    """
    return await _build_backend(settings, session, role="filter")


async def get_answer_llm_backend(
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> LLMBackend:
    """Backend for the answer-generation step (/api/ai/answer).

    Uses `*_answer_model` if set, otherwise falls back to the default
    runtime-selected model. The split lets a deployer pair a fast filter
    model with a smarter answer model — the answer step is the one that
    actually needs reasoning.
    """
    return await _build_backend(settings, session, role="answer")


async def _build_backend(
    settings: Settings, session: AsyncSession, *, role: str
) -> LLMBackend:
    backend = settings.llm_backend.lower()
    if backend == "anthropic":
        if not settings.anthropic_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="LLM backend 'anthropic' selected but ANTHROPIC_API_KEY is unset",
            )
        model = (
            settings.anthropic_answer_model
            if role == "answer" and settings.anthropic_answer_model
            else settings.anthropic_model
        )
        return create_backend(
            "anthropic",
            anthropic_api_key=settings.anthropic_api_key,
            anthropic_model=model,
        )
    if backend == "ollama":
        # OLLAMA_ANSWER_MODEL env is the deployer-pin path (backwards compat).
        # Otherwise the answer step reads its own quality from the DB so
        # the user can pick tagger and answer models independently.
        if role == "answer" and settings.ollama_answer_model:
            model = settings.ollama_answer_model
        elif role == "answer":
            model = await settings_service.get_active_answer_model(session)
        else:
            model = await settings_service.get_active_model(session)
        return create_backend(
            "ollama",
            ollama_base_url=settings.ollama_base_url,
            ollama_model=model,
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Unknown LLM backend: {settings.llm_backend!r}",
    )
