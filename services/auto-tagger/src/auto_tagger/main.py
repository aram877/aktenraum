import asyncio
import logging

import structlog
from aktenraum_core.llm import LLMBackend, create_backend
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient

from .config import Settings
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
    backend: LLMBackend,
    settings: Settings,
) -> None:
    """Single consumer for the extraction queue.

    Both the poller and the webhook enqueue document ids here. The poller
    cannot see in-flight extractions, so the same doc id can land in the queue
    twice if the LLM call is slower than the poll interval. We re-check the
    document's tags here and skip if any lifecycle tag is already set —
    cheaper than the LLM round-trip.
    """
    log = structlog.get_logger().bind(loop="extraction_worker")
    lifecycle_tags = set(LIFECYCLE_TAGS)
    while True:
        doc_id = await queue.get()
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
            await process_document(doc, paperless, backend, settings)
        except Exception as exc:
            log.exception("worker_error", doc_id=doc_id, error=str(exc))
        finally:
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


async def _propagation_loop(settings: Settings, paperless: PaperlessClient) -> None:
    log = structlog.get_logger().bind(loop="propagation")
    while True:
        try:
            docs = await paperless.get_documents_with_tag(
                "ai-approved", batch_size=settings.batch_size
            )
            if docs:
                log.info("poll_found_approved", count=len(docs))
                for doc in docs:
                    await process_approved_document(doc, paperless)
            else:
                log.debug("poll_no_approved")
        except Exception as exc:
            log.exception("poll_error", error=str(exc))

        await asyncio.sleep(settings.poll_interval_seconds)


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

    backend = create_backend(
        settings.llm_backend,
        anthropic_api_key=settings.anthropic_api_key or None,
        anthropic_model=settings.anthropic_model,
        ollama_base_url=settings.ollama_base_url,
        ollama_model=settings.ollama_model,
    )
    queue: asyncio.Queue[int] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)

    async with PaperlessClient(
        settings.paperless_base_url, settings.paperless_api_token
    ) as paperless:
        loops = [
            _extraction_worker(queue, paperless, backend, settings),
            _extraction_poller(queue, paperless, settings),
        ]
        if settings.enable_propagation:
            loops.append(_propagation_loop(settings, paperless))
        if settings.enable_http_server:
            loops.append(run_http_server(queue, settings))
        await asyncio.gather(*loops)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
