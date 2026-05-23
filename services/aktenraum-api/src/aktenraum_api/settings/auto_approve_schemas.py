from __future__ import annotations

from aktenraum_core.models import AutoApproveRule, DocumentType
from pydantic import BaseModel, Field, model_validator


class AutoApproveRulesResponse(BaseModel):
    rules: list[AutoApproveRule]


class AutoApproveRuleUpdateEntry(BaseModel):
    document_type: DocumentType
    enabled: bool
    min_confidence: float = Field(ge=0.0, le=1.0)


class AutoApproveRulesUpdateRequest(BaseModel):
    """Full-set replacement payload. The client MUST send exactly one
    entry per `DocumentType` enum value — no duplicates, no missing
    types, no unknown types.

    Partial updates would invite the "SPA shipped 25 entries and silently
    left the 26th unchanged" bug class. Full-set means: the payload IS
    the new state.
    """

    rules: list[AutoApproveRuleUpdateEntry]

    @model_validator(mode="after")
    def _validate_coverage(self) -> AutoApproveRulesUpdateRequest:
        expected = {dt for dt in DocumentType}
        seen: set[DocumentType] = set()
        duplicates: list[str] = []
        for entry in self.rules:
            if entry.document_type in seen:
                duplicates.append(entry.document_type.value)
            seen.add(entry.document_type)
        if duplicates:
            raise ValueError(
                "Duplicate document_type entries: " + ", ".join(sorted(set(duplicates)))
            )
        missing = expected - seen
        if missing:
            raise ValueError(
                "Missing document_type entries: "
                + ", ".join(sorted(t.value for t in missing))
            )
        return self
