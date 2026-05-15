import asyncio
import logging

import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient
from aktenraum_core.rag import OllamaEmbedder, QdrantVectorStore

from .backend_provider import build_active_backend
from .config import Settings
from .indexer import IndexingDeps, index_document
from .processing_state import ProcessingState
from .propagator import process_approved_document
from .tagger import process_document
from .webhook import run_http_server

# Bound the work queue. With a personal DMS doing ~10-50 docs/day this never
# fills, but a bound prevents runaway memory if something upstream goes wrong
# (paperless cron firing repeatedly, webhook spam, …).
_QUEUE_MAXSIZE = 1000


def _configure_logging(level: str) -> None:
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.dev.ConsoleRenderer(),
        ],
    )


async def _extraction_worker(
    queue: asyncio.Queue[int],
    paperless: PaperlessClient,
    settings: Settings,
    state: ProcessingState,
) -> None:
    """Single consumer for the extraction queue.

    Both the poller and the webhook enqueue document ids here. The poller
    cannot see in-flight extractions, so the same doc id can land in the queue
    twice if the LLM call is slower than the poll interval. We re-check the
    document's tags here and skip if any lifecycle tag is already set —
    cheaper than the LLM round-trip.

    The LLM backend is rebuilt per extraction from the runtime quality
    setting (DB-backed, written by the SPA Settings page). Cost is one
    cheap HTTP round-trip to aktenraum-api — negligible against the
    seconds the LLM takes. Means the operator's quality switch takes
    effect on the very next extraction.
    """
    log = structlog.get_logger().bind(loop="extraction_worker")
    lifecycle_tags = set(LIFECYCLE_TAGS)
    while True:
        doc_id = await queue.get()
        state.extraction = doc_id
        try:
            doc = await paperless.get_document(doc_id)
            current_tag_names = await _doc_tag_names(paperless, doc)
            if current_tag_names & lifecycle_tags:
                log.info(
                    "skip_already_processed",
                    doc_id=doc_id,
                    lifecycle_tags=sorted(current_tag_names & lifecycle_tags),
                )
                continue
            backend = await build_active_backend(settings)
            await process_document(doc, paperless, backend, settings)
        except Exception as exc:
            log.exception("worker_error", doc_id=doc_id, error=str(exc))
        finally:
            state.extraction = None
            queue.task_done()


async def _doc_tag_names(paperless: PaperlessClient, doc: dict) -> set[str]:
    """Return the names of tags currently on a document. Used by the worker
    to dedupe against in-flight or already-completed extractions."""
    tag_ids: list[int] = doc.get("tags", []) or []
    if not tag_ids:
        return set()
    # Resolve tag ids to names by reverse-lookup against the lifecycle set
    # only — that's all we care about for dedup.
    names: set[str] = set()
    for name in LIFECYCLE_TAGS:
        tid = await paperless._get_tag_id(name)
        if tid is not None and tid in tag_ids:
            names.add(name)
    return names


async def _extraction_poller(
    queue: asyncio.Queue[int], paperless: PaperlessClient, settings: Settings
) -> None:
    """Periodic safety-net scan: enqueue any unprocessed doc ids the webhook
    might have missed. Idempotent — duplicate enqueues are harmless because
    the worker re-fetches the doc and process_document re-checks the
    lifecycle tag set."""
    log = structlog.get_logger().bind(loop="extraction_poller")
    while True:
        try:
            docs = await paperless.get_unprocessed_documents(batch_size=settings.batch_size)
            if docs:
                log.info("poll_found_documents", count=len(docs))
                for doc in docs:
                    queue.put_nowait(doc["id"])
            else:
                log.debug("poll_no_new_documents")
        except Exception as exc:
            log.exception("poll_error", error=str(exc))

        await asyncio.sleep(settings.poll_interval_seconds)


async def _propagation_loop(
    settings: Settings,
    paperless: PaperlessClient,
    indexing_queue: asyncio.Queue[int] | None,
    state: ProcessingState,
) -> None:
    log = structlog.get_logger().bind(loop="propagation")
    while True:
        try:
            docs = await paperless.get_documents_with_tag(
                "ai-approved", batch_size=settings.batch_size
            )
            if docs:
                log.info("poll_found_approved", count=len(docs))
                for doc in docs:
                    state.propagation = doc["id"]
                    try:
                        await process_approved_document(
                            doc, paperless, indexing_queue=indexing_queue
                        )
                    finally:
                        state.propagation = None
            else:
                log.debug("poll_no_approved")
        except Exception as exc:
            log.exception("poll_error", error=str(exc))

        await asyncio.sleep(settings.poll_interval_seconds)


async def _indexer_worker(
    queue: asyncio.Queue[int],
    deps: IndexingDeps,
    state: ProcessingState,
) -> None:
    """Drain the indexing queue, RAG-index one doc at a time.

    Sequential rather than concurrent: bge-m3 inference is the
    bottleneck and Ollama already manages batching internally — adding
    a layer of asyncio fan-out wouldn't increase throughput on a
    single-GPU host. If/when this changes (multi-GPU, dedicated
    inference server), bump to a fan-out worker pool.

    Per-doc errors are caught inside `index_document` so this loop
    never exits — exiting would cancel the whole asyncio.gather
    (extraction worker, poller, propagation, http server) due to how
    asyncio handles exceptions across tasks.
    """
    log = structlog.get_logger().bind(loop="indexer_worker")
    log.info("indexer_worker_started")
    while True:
        doc_id = await queue.get()
        state.indexer = doc_id
        try:
            await index_document(doc_id, deps)
        finally:
            state.indexer = None
            queue.task_done()


async def run() -> None:
    settings = Settings()
    settings.validate_backend()
    _configure_logging(settings.log_level)

    log = structlog.get_logger()
    log.info(
        "auto_tagger_starting",
        backend=settings.llm_backend,
        model=settings.anthropic_model
        if settings.llm_backend == "anthropic"
        else settings.ollama_model,
        propagation_enabled=settings.enable_propagation,
        http_server_enabled=settings.enable_http_server,
    )

    # The extraction worker rebuilds the backend per doc via
    # build_active_backend(settings), consulting aktenraum-api for the
    # runtime quality. No startup-time backend is needed.
    queue: asyncio.Queue[int] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    state = ProcessingState()

    # RAG indexing is opt-in: when QDRANT_URL is empty we don't construct a
    # vector store, don't run the indexer worker, and don't enqueue from the
    # propagator. Existing extraction + propagation paths are unchanged.
    indexing_queue: asyncio.Queue[int] | None = None
    indexer_deps: IndexingDeps | None = None
    if settings.qdrant_url:
        indexing_queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        log.info(
            "indexing_enabled",
            qdrant_url=settings.qdrant_url,
            embedding_model=settings.embedding_model,
        )

    async with PaperlessClient(
        settings.paperless_base_url, settings.paperless_api_token
    ) as paperless:
        # Construct RAG deps inside the PaperlessClient context so the
        # vector store's connection-pool lifetime is bounded by the same
        # `async with` shutdown.
        vector_store: QdrantVectorStore | None = None
        if settings.qdrant_url:
            vector_store = QdrantVectorStore(
                url=settings.qdrant_url,
                # bge-m3 dense dim. The wrapper has the same default but
                # surfacing it here makes the dependency explicit for ops.
                dense_dim=1024,
            )
            await vector_store.ensure_collection()
            indexer_deps = IndexingDeps(
                paperless=paperless,
                embedder=OllamaEmbedder(
                    base_url=settings.ollama_base_url,
                    model=settings.embedding_model,
                ),
                vector_store=vector_store,
            )

        loops = [
            _extraction_worker(queue, paperless, settings, state),
            _extraction_poller(queue, paperless, settings),
        ]
        if settings.enable_propagation:
            loops.append(
                _propagation_loop(settings, paperless, indexing_queue, state)
            )
        if settings.enable_http_server:
            loops.append(run_http_server(queue, settings, state))
        if indexing_queue is not None and indexer_deps is not None:
            loops.append(_indexer_worker(indexing_queue, indexer_deps, state))

        try:
            await asyncio.gather(*loops)
        finally:
            if vector_store is not None:
                await vector_store.aclose()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
