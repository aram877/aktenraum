from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class InboxItem(BaseModel):
    """One row in the /inbox list view."""

    id: int
    title: str
    original_file_name: str | None = None
    created: date | None = None
    ai_correspondent: str | None = None
    ai_document_type: str | None = None
    ai_title: str | None = None
    ai_issue_date: str | None = None
    ai_confidence: float | None = None
    low_confidence: bool = False
    # Populated by the auto-tagger / propagator / indexer whenever they tag
    # ai-error / ai-propagation-error / ai-index-error. Cleared on the next
    # successful run. Empty for docs that have never errored.
    ai_error_message: str | None = None


class InboxDetail(InboxItem):
    """Full review payload for /inbox/{id}."""

    ai_reference_numbers: str | None = None
    ai_suggested_tags: str | None = None
    ai_summary_de: str | None = None
    ai_backend: str | None = None
    ai_model: str | None = None
    # One-sentence explanation of what drove `ai_confidence`. Rendered
    # under the percentage in the review form so the user knows whether
    # a 50 % score reflects OCR quality, doc-type ambiguity, or just LLM
    # hedging on a clean doc.
    ai_confidence_reason: str | None = None
    content_excerpt: str = ""
    tags: list[str] = Field(default_factory=list)
    type_fields: dict[str, str] | None = None


class InboxFieldUpdate(BaseModel):
    """Partial update body for PATCH /inbox/{id} and the optional approve body.

    Every field is optional; missing fields are left untouched. Field names
    mirror the Paperless custom-field names exactly so the boundary mapping
    stays trivial.
    """

    ai_document_type: str | None = None
    ai_correspondent: str | None = None
    ai_title: str | None = None
    ai_issue_date: str | None = None
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
