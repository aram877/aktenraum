from __future__ import annotations

from datetime import date

from aktenraum_core.models import DocumentType
from pydantic import BaseModel, Field, model_validator


class SearchFilter(BaseModel):
    """Closed-enum filter the LLM emits and the SPA edits.

    Every field is optional individually. An empty filter means "no constraints"
    and translates to the broadest Paperless query. `tags` is open-vocabulary
    (anything the auto-tagger has emitted) and applied with AND semantics —
    a result must carry every requested tag.
    """

    document_type: DocumentType | None = None
    correspondent: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    text: str | None = None
    tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _strip_strings(self) -> SearchFilter:
        if self.correspondent is not None:
            stripped = self.correspondent.strip()
            self.correspondent = stripped or None
        if self.text is not None:
            stripped = self.text.strip()
            self.text = stripped or None
        # Drop empty/whitespace tags and dedupe while preserving order. Keeps
        # the rendered chip list clean even when an LLM emits ["", "Foo", "Foo"].
        seen: set[str] = set()
        cleaned: list[str] = []
        for raw in self.tags:
            if raw is None:
                continue
            stripped = raw.strip()
            if not stripped or stripped in seen:
                continue
            cleaned.append(stripped)
            seen.add(stripped)
        self.tags = cleaned
        return self


class DocumentSummary(BaseModel):
    id: int
    title: str
    original_file_name: str | None = None
    correspondent: str | None = None
    document_type: str | None = None
    created: date | None = None
    # Subset of the document's tag names that match the AI lifecycle vocabulary
    # (ai-propagated / ai-approved / ai-rejected / ai-error / etc.). The SPA
    # renders this as a "Wartet auf KI" / "Wird übertragen" / … badge so the
    # user can spot in-flight or stuck documents wherever a card is shown.
    # Empty list means the document has no AI lifecycle tag — it might be
    # legacy or freshly uploaded.
    lifecycle_tags: list[str] = Field(default_factory=list)


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


class AnswerRequest(BaseModel):
    question: str = Field(..., min_length=1, description="German question from the user")


class AnswerOutput(BaseModel):
    """Schema the answer-generation LLM must satisfy."""

    answer_de: str = Field(..., description="Antwort auf Deutsch, höchstens 3 Sätze")
    cited_ids: list[int] = Field(
        default_factory=list,
        description="IDs der Dokumente, aus denen die Antwort stammt",
    )


class AnswerResponse(BaseModel):
    question: str
    answer_de: str
    citations: list[DocumentSummary] = Field(default_factory=list)
    filter: SearchFilter
    total: int
