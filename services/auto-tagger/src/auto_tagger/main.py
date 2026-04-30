import asyncio
import logging

import structlog

from .config import Settings
from .llm.base import LLMBackend
from .llm.factory import create_backend
from .paperless import PaperlessClient
from .propagator import process_approved_document
from .tagger import process_document


def _configure_logging(level: str) -> None:
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.dev.ConsoleRenderer(),
        ],
    )


async def _extraction_loop(
    settings: Settings, paperless: PaperlessClient, backend: LLMBackend
) -> None:
    log = structlog.get_logger().bind(loop="extraction")
    while True:
        try:
            docs = await paperless.get_unprocessed_documents(batch_size=settings.batch_size)
            if docs:
                log.info("poll_found_documents", count=len(docs))
                for doc in docs:
                    await process_document(doc, paperless, backend, settings)
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
    )

    backend = create_backend(settings)

    async with PaperlessClient(
        settings.paperless_base_url, settings.paperless_api_token
    ) as paperless:
        loops = [_extraction_loop(settings, paperless, backend)]
        if settings.enable_propagation:
            loops.append(_propagation_loop(settings, paperless))
        await asyncio.gather(*loops)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
