from __future__ import annotations

from dataclasses import asdict

from aktenraum_core.models import TYPE_FIELD_SCHEMA
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..db.session import get_session
from ..paperless_gw import PaperlessGateway
from . import service
from .schemas import TypeFieldsPatch, TypeFieldsResponse

router = APIRouter(tags=["type-fields"])


def _require_user_or_secret(
    request: Request,
    x_aktenraum_secret: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """Allow JWT-authenticated users OR the shared webhook secret (for auto-tagger)."""
    if x_aktenraum_secret is not None and settings.webhook_secret:
        if x_aktenraum_secret == settings.webhook_secret:
            return
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid secret")
    # Fall through to JWT check via cookie
    cookie_name = settings.cookie_name
    token = request.cookies.get(cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from ..auth.jwt import verify_token
    if verify_token(token, secret=settings.jwt_secret) is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")


@router.get("/document-types/schema")
async def get_schema(
    response: Response,
    _user: User = Depends(get_current_user),
) -> dict:
    response.headers["Cache-Control"] = "private, max-age=3600"
    return {
        doc_type.value: [asdict(f) for f in fields]
        for doc_type, fields in TYPE_FIELD_SCHEMA.items()
    }


@router.get("/documents/{doc_id}/type-fields", response_model=TypeFieldsResponse)
async def get_type_fields(
    doc_id: int,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> TypeFieldsResponse:
    row = await service.get(session, doc_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No type-specific fields found",
        )
    return TypeFieldsResponse(document_type=row.document_type, fields=row.fields or {})


@router.patch("/documents/{doc_id}/type-fields", response_model=TypeFieldsResponse)
async def patch_type_fields(
    doc_id: int,
    body: TypeFieldsPatch,
    _auth: None = Depends(_require_user_or_secret),
    session: AsyncSession = Depends(get_session),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> TypeFieldsResponse:
    doc_type_str = await service._infer_document_type(gateway, doc_id)
    unknown = service.validate_field_names(doc_type_str, body.fields)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown fields for type '{doc_type_str}': {unknown}",
        )

    row = await service.upsert(session, gateway, doc_id, body.fields)
    return TypeFieldsResponse(document_type=row.document_type, fields=row.fields or {})
