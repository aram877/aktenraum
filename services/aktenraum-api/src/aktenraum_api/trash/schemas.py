from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel


class TrashItem(BaseModel):
    """One row in /api/trash/.

    Shape mirrors `InboxItem` for the columns the SPA renders in both
    the inbox queue and the trash list, plus `deleted_at` so the SPA
    can compute "noch N Tage" against the 30-day auto-purge default.
    """

    id: int
    title: str
    original_file_name: str | None = None
    created: date | None = None
    deleted_at: datetime | None = None
    # Native lookups (resolved from correspondent / document_type ids
    # via the gateway's id→name caches). Fall back to the auto-tagger's
    # AI-suggested string when the native is unset.
    correspondent: str | None = None
    document_type: str | None = None
    ai_correspondent: str | None = None
    ai_document_type: str | None = None
    ai_summary_de: str | None = None


class TrashList(BaseModel):
    results: list[TrashItem]
    total: int
    page: int
    page_size: int


class EmptyTrashResponse(BaseModel):
    """Response body for POST /api/trash/empty.

    Reports the number of docs that were hard-deleted so the SPA can
    render an accurate confirmation toast ("7 Dokumente endgültig
    gelöscht").
    """

    emptied: int
