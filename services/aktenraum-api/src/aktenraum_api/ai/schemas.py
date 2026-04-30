from __future__ import annotations

from datetime import date

from aktenraum_core.models import DocumentType
from pydantic import BaseModel, Field, model_validator


class SearchFilter(BaseModel):
    """Closed-enum filter the LLM emits and the SPA edits.

    Every field is optional individually. An empty filter means "no constraints"
    and translates to the broadest Paperless query.
    """

    document_type: DocumentType | None = None
    correspondent: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    min_amount: float | None = None
    max_amount: float | None = None
    text: str | None = None

    @model_validator(mode="after")
    def _strip_strings(self) -> SearchFilter:
        if self.correspondent is not None:
            stripped = self.correspondent.strip()
            self.correspondent = stripped or None
        if self.text is not None:
            stripped = self.text.strip()
            self.text = stripped or None
        return self


class DocumentSummary(BaseModel):
    id: int
    title: str
    correspondent: str | None = None
    document_type: str | None = None
    created: date | None = None
    monetary_amount: str | None = None


class AskRequest(BaseModel):
    query: str | None = None
    filter: SearchFilter | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> AskRequest:
        if (self.query is None) == (self.filter is None):
            raise ValueError("Exactly one of `query` or `filter` is required")
        if self.query is not None and not self.query.strip():
            raise ValueError("`query` must not be empty")
        return self


class AskResponse(BaseModel):
    filter: SearchFilter
    results: list[DocumentSummary] = Field(default_factory=list)
    explanation: str
    total: int
