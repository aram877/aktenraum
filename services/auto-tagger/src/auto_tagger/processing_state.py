"""Shared in-memory snapshot of doc ids currently in flight.

Each pipeline stage (extraction worker, propagation loop, indexer worker)
owns one slot in this state object and sets/clears it around the per-doc
call. The HTTP server reads it for `GET /processing` so the SPA can show
a spinner on the specific doc the auto-tagger is working on right now —
instead of every doc with no lifecycle tag showing the same generic
"Wartet auf KI" badge.

Concurrency: every stage runs as one serial consumer of its own queue, so
each slot only ever has 0 or 1 entry. Reads/writes are single-attribute
assignments and the GIL guarantees they don't tear. We deliberately
*don't* add an asyncio.Lock — the data is advisory (a one-second-stale
snapshot is fine for spinner UX) and the lock would just add coupling
between the workers and the HTTP listener.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProcessingState:
    extraction: int | None = None
    propagation: int | None = None
    indexer: int | None = None

    def snapshot(self) -> dict[str, int | None]:
        return {
            "extraction": self.extraction,
            "propagation": self.propagation,
            "indexer": self.indexer,
        }

    def active_ids(self) -> list[int]:
        """Return the unique doc ids currently in any pipeline slot."""
        seen: set[int] = set()
        out: list[int] = []
        for val in (self.extraction, self.propagation, self.indexer):
            if val is not None and val not in seen:
                seen.add(val)
                out.append(val)
        return out
