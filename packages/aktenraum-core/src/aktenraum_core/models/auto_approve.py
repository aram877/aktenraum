from datetime import datetime

from pydantic import BaseModel, Field

from .extraction import DocumentType


class AutoApproveRule(BaseModel):
    """Per-document-type auto-approve rule.

    `enabled` + `min_confidence` together decide whether the auto-tagger
    routes an extraction to `ai-approved` (auto-approve) or `ai-pending`
    (review). The rule set is edited from the SPA's Settings page,
    persisted by aktenraum-api, and consumed by the auto-tagger over HTTP
    with a 60-second TTL cache.
    """

    document_type: DocumentType
    enabled: bool = False
    min_confidence: float = Field(default=0.90, ge=0.0, le=1.0)
    updated_at: datetime | None = None
    updated_by: str | None = None
