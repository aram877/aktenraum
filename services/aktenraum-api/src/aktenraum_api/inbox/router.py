from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user
from ..db.models import User
from ..db.session import get_session
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessConflictError,
    PaperlessGateway,
    PaperlessNotFoundError,
)
from . import service
from .schemas import InboxDetail, InboxFieldUpdate, InboxList

log = structlog.get_logger()

router = APIRouter(prefix="/inbox", tags=["inbox"])


_ORDERING_ALLOWLIST = frozenset(
    ["-modified", "modified", "-created", "created", "-added", "added", "title", "-title"]
)


@router.get("/", response_model=InboxList)
async def list_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    ordering: str = Query("-modified"),
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> InboxList:
    if ordering not in _ORDERING_ALLOWLIST:
        ordering = "-modified"
    try:
        return await service.list_pending(
            gateway, page=page, page_size=page_size, ordering=ordering
        )
    except PaperlessAuthError as e:
        raise _bad_gateway() from e


@router.get("/{doc_id}", response_model=InboxDetail)
async def get_inbox_detail(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    session: AsyncSession = Depends(get_session),
) -> InboxDetail:
    try:
        return await service.get_detail(gateway, doc_id, session=session)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e


@router.patch("/{doc_id}", response_model=InboxDetail)
async def patch_inbox(
    doc_id: int,
    body: InboxFieldUpdate,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> InboxDetail:
    try:
        return await service.apply_field_update(gateway, doc_id, body)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e


@router.post("/{doc_id}/approve", response_model=InboxDetail)
async def approve_inbox(
    doc_id: int,
    body: InboxFieldUpdate | None = None,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> InboxDetail:
    try:
        return await service.approve(gateway, doc_id, body)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    except PaperlessConflictError as e:
        raise _conflict(doc_id) from e


@router.post("/{doc_id}/reject", response_model=InboxDetail)
async def reject_inbox(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> InboxDetail:
    try:
        return await service.reject(gateway, doc_id)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    except PaperlessConflictError as e:
        raise _conflict(doc_id) from e


@router.get("/{doc_id}/preview")
async def preview_inbox(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> StreamingResponse:
    try:
        stream = gateway.stream_preview(doc_id)
        # Pull the first chunk eagerly so PaperlessNotFoundError /
        # PaperlessAuthError surface as HTTPException before we hand the
        # iterator to StreamingResponse.
        first = await _peek_async(stream)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e

    async def gen():
        if first is not None:
            yield first
        async for chunk in stream:
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="application/pdf",
        headers={"Cache-Control": "private, max-age=300"},
    )


async def _peek_async(it):
    async for chunk in it:
        return chunk
    return None


def _not_found(doc_id: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Document {doc_id} not found",
    )


def _bad_gateway() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Paperless rejected the API token",
    )


def _conflict(doc_id: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Document {doc_id} was modified concurrently. Refresh and try again."
        ),
    )
