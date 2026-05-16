import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from aktenraum_core.rag import LocalReranker, OllamaEmbedder, QdrantVectorStore
from fastapi import FastAPI

from .ai import router as ai_router
from .ai.retrieval import RetrievalDeps
from .auth import bootstrap_user_if_empty
from .auth import router as auth_router
from .config import Settings
from .db.session import build_engine_and_sessionmaker
from .documents import router as documents_router
from .health import router as health_router
from .inbox import router as inbox_router
from .library import router as library_router
from .middleware import CSRFMiddleware, SecurityHeadersMiddleware
from .paperless_gw import PaperlessGateway
from .settings import router as settings_router
from .type_fields import router as type_fields_router


def _configure_logging(level: str) -> None:
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ],
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    _configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine, SessionLocal = build_engine_and_sessionmaker(settings.database_url)
        app.state.engine = engine
        app.state.session_factory = SessionLocal
        async with SessionLocal() as session:
            await bootstrap_user_if_empty(
                session,
                username=settings.bootstrap_username,
                password=settings.bootstrap_password,
            )
        if settings.paperless_api_token:
            app.state.paperless_gateway = PaperlessGateway(
                base_url=settings.paperless_base_url,
                api_token=settings.paperless_api_token,
                ttl_seconds=settings.correspondent_list_ttl_seconds,
            )
        else:
            app.state.paperless_gateway = None

        # RAG retrieval deps (Phase 1.8): only constructed when
        # QDRANT_URL is set. Built once at startup so the bge-reranker
        # 600 MB load doesn't repeat per request. We also kick off the
        # reranker model load *in the background* during lifespan so the
        # first /ask doesn't pay the ~5min HuggingFace-download cliff
        # inside a request handler. Lifespan returns immediately; the
        # download proceeds while the API starts serving — concurrent
        # /ask calls during the warmup window still wait on the same
        # asyncio.Lock inside the reranker, but they no longer block
        # other handlers' event-loop slots.
        if settings.qdrant_url:
            vector_store = QdrantVectorStore(
                url=settings.qdrant_url,
                dense_dim=1024,
            )
            try:
                await vector_store.ensure_collection()
                reranker = LocalReranker(model_name=settings.reranker_model)
                app.state.rag_vector_store = vector_store
                app.state.retrieval_deps = RetrievalDeps(
                    embedder=OllamaEmbedder(
                        base_url=settings.ollama_base_url,
                        model=settings.embedding_model,
                    ),
                    vector_store=vector_store,
                    reranker=reranker,
                )

                async def _warm_reranker() -> None:
                    try:
                        await reranker._ensure_loaded()  # noqa: SLF001
                        structlog.get_logger().info("reranker_prewarm_complete")
                    except Exception as exc:  # noqa: BLE001
                        structlog.get_logger().warning(
                            "reranker_prewarm_failed", error=str(exc)
                        )

                app.state._reranker_warmup_task = asyncio.create_task(
                    _warm_reranker()
                )
            except Exception:
                # Don't crash the API on Qdrant unreachable at boot —
                # the rest of the API stays usable, just without RAG.
                app.state.rag_vector_store = None
                app.state.retrieval_deps = None
        else:
            app.state.rag_vector_store = None
            app.state.retrieval_deps = None

        yield
        gateway = getattr(app.state, "paperless_gateway", None)
        if gateway is not None:
            await gateway.aclose()
        rag_store = getattr(app.state, "rag_vector_store", None)
        if rag_store is not None:
            await rag_store.aclose()
        warmup = getattr(app.state, "_reranker_warmup_task", None)
        if warmup is not None and not warmup.done():
            warmup.cancel()
            try:
                await warmup
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await engine.dispose()

    app = FastAPI(
        title="aktenraum-api",
        version="0.1.0",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CSRFMiddleware)
    app.include_router(health_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(ai_router, prefix="/api")
    app.include_router(documents_router, prefix="/api")
    app.include_router(inbox_router, prefix="/api")
    app.include_router(library_router, prefix="/api")
    app.include_router(type_fields_router, prefix="/api")
    app.include_router(settings_router, prefix="/api")
    return app
