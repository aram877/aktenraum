"""Mapping between the user-facing quality label and the Ollama model tag.

Kept here (rather than in the SPA) so both the API and the auto-tagger
resolve the same name from the same source of truth. Add new entries
with care — the SPA's hardcoded radio list needs to stay in sync.
"""

from __future__ import annotations

from typing import Literal

Quality = Literal["high", "medium"]

# Ordered for UI rendering: highest first.
# Both tiers currently point at the only instruct model pulled on this host
# (qwen2.5:14b-instruct-q8_0). To make "high" meaningfully better, pull a
# larger instruct model (e.g. qwen2.5:32b-instruct-q8_0) and set it here.
QUALITY_TO_MODEL: dict[str, str] = {
    "high": "qwen2.5:14b-instruct-q8_0",
    "medium": "qwen2.5:14b-instruct-q8_0",
}

QUALITIES: tuple[str, ...] = tuple(QUALITY_TO_MODEL.keys())

DEFAULT_QUALITY: str = "high"


def resolve_model(quality: str) -> str:
    """Resolve a quality label to the underlying Ollama model tag.

    Falls back to the high-tier model if the stored value is unknown
    (shouldn't happen with the migration's seed + PATCH validation, but
    defends against an out-of-band DB edit).
    """
    return QUALITY_TO_MODEL.get(quality, QUALITY_TO_MODEL[DEFAULT_QUALITY])
