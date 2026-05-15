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
    server-side so they never appear here. `tags` is the *user-facing* tag set
    (everything except the lifecycle vocabulary), so the SPA can show topical
    chips like "Lebenslauf" / "Versicherung" alongside the badge.
    """

    id: int
    title: str
    original_file_name: str | None = None
    created: date | None = None
    correspondent: str | None = None
    document_type: str | None = None
    monetary_amount: str | None = None
    lifecycle_tags: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class LibraryList(BaseModel):
    results: list[LibraryItem]
    total: int
    page: int
    page_size: int


class TagFacet(BaseModel):
    """One entry in the library tag facet.

    `count` is the number of non-pending documents carrying this tag,
    sampled from the most recent `_FACET_SAMPLE_SIZE` library docs (see
    `service.list_tag_facet`). Tags whose live count falls below the
    minimum-frequency threshold are filtered out before the response.
    """

    name: str
    count: int


class TagFacetList(BaseModel):
    results: list[TagFacet]
