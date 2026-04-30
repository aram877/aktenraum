from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class LibraryItem(BaseModel):
    """One row in the /library list view.

    Carries enough metadata for the table cells without a second per-doc fetch.
    `lifecycle_tags` is the subset of the doc's tag names that match the
    aktenraum lifecycle vocabulary (ai-approved / ai-propagated / ai-rejected /
    ai-error / ai-propagation-error) — the SPA renders one badge per tag so
    the user can spot abnormal docs at a glance. Pending docs are excluded
    server-side so they never appear here.
    """

    id: int
    title: str
    created: date | None = None
    correspondent: str | None = None
    document_type: str | None = None
    monetary_amount: str | None = None
    lifecycle_tags: list[str] = Field(default_factory=list)


class LibraryList(BaseModel):
    results: list[LibraryItem]
    total: int
    page: int
    page_size: int
