"""Cross-platform Paperless bootstrap entry point.

Equivalent to `scripts/bootstrap-paperless.sh` but runs entirely inside
the auto-tagger container — so the operator never needs a Unix shell on
the host. Idempotent: existing fields and tags are left untouched. The
canonical invocation is via the Taskfile:

    task paperless:bootstrap   # → docker compose exec auto-tagger
                               #   /app/.venv/bin/python -m auto_tagger.bootstrap_paperless

The shell script stays in scripts/bootstrap-paperless.sh for users who
prefer to run from a host bash shell directly; the two are kept
deliberately in lockstep — the same list of (field, data_type) and
(tag, color) entries lives here and there.
"""

from __future__ import annotations

import asyncio
import sys

import structlog
from aktenraum_core.paperless import PaperlessClient

from .config import Settings

log = structlog.get_logger()


# Order matters only cosmetically (log output). The set must stay in
# lockstep with `scripts/bootstrap-paperless.sh`.
_CUSTOM_FIELDS: list[tuple[str, str]] = [
    ("ai_document_type", "string"),
    ("ai_correspondent", "string"),
    ("ai_title", "string"),
    ("ai_issue_date", "date"),
    ("ai_reference_numbers", "string"),
    ("ai_suggested_tags", "string"),
    ("ai_summary_de", "longtext"),
    ("ai_confidence", "float"),
    ("ai_backend", "string"),
    ("ai_model", "string"),
    ("ai_error_message", "longtext"),
    ("ai_confidence_reason", "longtext"),
]

_LIFECYCLE_TAGS: list[tuple[str, str]] = [
    ("ai-pending", "#f59e0b"),
    ("ai-approved", "#22c55e"),
    ("ai-auto-approved", "#10b981"),
    ("ai-rejected", "#6b7280"),
    ("ai-propagated", "#3b82f6"),
    ("ai-propagation-error", "#ef4444"),
    ("ai-low-confidence", "#fb923c"),
    ("ai-error", "#ef4444"),
]


async def _run() -> int:
    settings = Settings()
    print(f"Bootstrapping Paperless at {settings.paperless_base_url}...")

    if not settings.paperless_api_token:
        print(
            "ERROR: PAPERLESS_API_TOKEN is empty. Mint one via the Paperless "
            "UI / API and put it in docker/auto-tagger.env, then re-run.",
            file=sys.stderr,
        )
        return 1

    async with PaperlessClient(
        settings.paperless_base_url, settings.paperless_api_token
    ) as paperless:
        print("\nCustom fields:")
        for name, data_type in _CUSTOM_FIELDS:
            _id, created = await paperless.ensure_custom_field(name, data_type)
            print(
                f"  {'[created]' if created else '[skip]   '} "
                f"{name} ({data_type})"
            )

        print("\nTags:")
        for name, color in _LIFECYCLE_TAGS:
            _id, created = await paperless.ensure_tag(name, color)
            print(f"  {'[created]' if created else '[skip]   '} {name}")

    print("\nBootstrap complete.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
