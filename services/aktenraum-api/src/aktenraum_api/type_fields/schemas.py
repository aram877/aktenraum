from __future__ import annotations

from pydantic import BaseModel


class TypeFieldsResponse(BaseModel):
    document_type: str
    fields: dict[str, str]


class TypeFieldsPatch(BaseModel):
    fields: dict[str, str | None]
    document_type: str | None = None
