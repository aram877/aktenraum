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
    # `created` = the document's own date (Paperless `created_date`), e.g. the
    # invoice's issue date. `added` = when Paperless ingested the file. The
    # SPA renders them side by side as "Dokumentdatum" / "Hinzugefügt am".
    created: date | None = None
    added: date | None = None
    correspondent: str | None = None
    document_type: str | None = None
    lifecycle_tags: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    # Populated when the doc is in an error state (ai-error /
    # ai-propagation-error / ai-index-error). Lets the SPA show a tooltip on
    # the status badge with the actual reason instead of a bare "Fehler".
    ai_error_message: str | None = None
    # True ONLY on rows the page-1 prepend logic projected from the
    # auto-tagger's /processing endpoint. Lets the SPA render the
    # ProcessingBadge spinner on rows the worker is actively handling so
    # the user doesn't have to paginate to find them. Natural-sort rows
    # are always False.
    is_processing: bool = False


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
