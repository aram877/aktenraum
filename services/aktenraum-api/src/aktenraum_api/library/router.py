from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..paperless_gw import PaperlessAuthError, PaperlessGateway
from . import service
from .schemas import LibraryList, TagFacetList

router = APIRouter(prefix="/library", tags=["library"])

# Allowed Paperless ordering fields. Anything else is rejected so a typo or a
# crafted client cannot trip a 500 from the upstream.
_ALLOWED_ORDERING = {
    "-created",
    "created",
    "-modified",
    "modified",
    "title",
    "-title",
}


@router.get("/", response_model=LibraryList)
async def list_library(
    document_type: str | None = Query(
        None, description="Exact name from the document-type taxonomy"
    ),
    correspondent: str | None = Query(None, description="Exact correspondent name"),
    date_from: date | None = Query(None, description="created_date >= this"),
    date_to: date | None = Query(None, description="created_date <= this"),
    text: str | None = Query(None, description="Free-text Paperless full-text search"),
    tags: list[str] | None = Query(
        None,
        description=(
            "Tag names; AND semantics — a doc must carry every requested tag. "
            "Repeat the param for multiple tags (?tags=Lebenslauf&tags=Versicherung)."
        ),
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    ordering: str = Query("-created"),
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    settings: Settings = Depends(get_settings),
) -> LibraryList:
    if ordering not in _ALLOWED_ORDERING:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"ordering must be one of {sorted(_ALLOWED_ORDERING)}",
        )
    try:
        return await service.list_library(
            gateway,
            document_type=document_type,
            correspondent=correspondent,
            date_from=date_from,
            date_to=date_to,
            text=text,
            tags=tags,
            page=page,
            page_size=page_size,
            ordering=ordering,
            settings=settings,
        )
    except PaperlessAuthError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        ) from e


@router.get("/tags", response_model=TagFacetList)
async def list_tag_facet(
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> TagFacetList:
    try:
        return await service.list_tag_facet(gateway)
    except PaperlessAuthError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        ) from e
