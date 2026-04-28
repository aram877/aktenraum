import asyncio
import logging

import structlog

from .config import Settings
from .llm.factory import create_backend
from .paperless import PaperlessClient
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


async def run() -> None:
    settings = Settings()
    settings.validate_backend()
    _configure_logging(settings.log_level)

    log = structlog.get_logger()
    log.info("auto_tagger_starting", backend=settings.llm_backend, model=settings.anthropic_model if settings.llm_backend == "anthropic" else settings.ollama_model)

    backend = create_backend(settings)

    async with PaperlessClient(settings.paperless_base_url, settings.paperless_api_token) as paperless:
        while True:
            try:
                docs = await paperless.get_unprocessed_documents(batch_size=settings.batch_size)
                if docs:
                    log.info("poll_found_documents", count=len(docs))
                    for doc in docs:
                        await process_document(doc, paperless, backend, settings.max_tokens_input)
                else:
                    log.debug("poll_no_new_documents")
            except Exception as exc:
                log.error("poll_error", error=str(exc))

            await asyncio.sleep(settings.poll_interval_seconds)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
