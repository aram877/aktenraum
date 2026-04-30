from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class InboxItem(BaseModel):
    """One row in the /inbox list view."""

    id: int
    title: str
    created: date | None = None
    ai_correspondent: str | None = None
    ai_document_type: str | None = None
    ai_issue_date: str | None = None
    ai_monetary_amount: str | None = None
    ai_confidence: float | None = None
    low_confidence: bool = False


class InboxDetail(InboxItem):
    """Full review payload for /inbox/{id}."""

    ai_due_date: str | None = None
    ai_expiry_date: str | None = None
    ai_reference_numbers: str | None = None
    ai_suggested_tags: str | None = None
    ai_summary_de: str | None = None
    ai_backend: str | None = None
    ai_model: str | None = None
    content_excerpt: str = ""
    tags: list[str] = Field(default_factory=list)


class InboxFieldUpdate(BaseModel):
    """Partial update body for PATCH /inbox/{id} and the optional approve body.

    Every field is optional; missing fields are left untouched. Field names
    mirror the Paperless custom-field names exactly so the boundary mapping
    stays trivial.
    """

    ai_document_type: str | None = None
    ai_correspondent: str | None = None
    ai_issue_date: str | None = None
    ai_due_date: str | None = None
    ai_expiry_date: str | None = None
    ai_monetary_amount: str | None = None
    ai_reference_numbers: str | None = None
    ai_suggested_tags: str | None = None
    ai_summary_de: str | None = None

    def populated(self) -> dict[str, str | None]:
        """Return only fields explicitly set in the request body."""
        return {
            name: getattr(self, name)
            for name in self.model_fields_set
        }


class InboxList(BaseModel):
    results: list[InboxItem]
    total: int
    page: int
    page_size: int
