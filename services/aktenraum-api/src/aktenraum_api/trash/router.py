from __future__ import annotations

import structlog
from aktenraum_core.rag import QdrantVectorStore
from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..ai.deps import get_paperless_gateway, get_vector_store_optional
from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessConflictError,
    PaperlessGateway,
    PaperlessNotFoundError,
)
from . import service
from .schemas import EmptyTrashResponse, TrashList

log = structlog.get_logger()

router = APIRouter(prefix="/trash", tags=["trash"])


# Paperless `/api/trash/` accepts the same ordering vocabulary as
# `/api/documents/` for the common columns. Restrict to the few the
# SPA actually uses so we don't pass-through arbitrary user input.
_ORDERING_ALLOWLIST = frozenset(
    [
        "deleted_at",
        "-deleted_at",
        "created",
        "-created",
        "title",
        "-title",
    ]
)


@router.get("/", response_model=TrashList)
async def list_trash(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    ordering: str = Query("deleted_at"),
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> TrashList:
    if ordering not in _ORDERING_ALLOWLIST:
        ordering = "deleted_at"
    try:
        return await service.list_trashed(
            gateway, page=page, page_size=page_size, ordering=ordering
        )
    except PaperlessAuthError as e:
        raise _bad_gateway() from e


@router.post(
    "/{doc_id}/restore",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def restore_doc(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> None:
    try:
        await service.restore(gateway, doc_id)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    except PaperlessConflictError as e:
        raise _conflict(doc_id) from e


@router.post(
    "/{doc_id}/delete",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_doc_forever(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    vector_store: QdrantVectorStore | None = Depends(get_vector_store_optional),
) -> None:
    try:
        await service.delete_forever(gateway, vector_store, doc_id)
    except PaperlessNotFoundError as e:
        raise _not_found(doc_id) from e
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    except PaperlessConflictError as e:
        raise _conflict(doc_id) from e


@router.post("/empty", response_model=EmptyTrashResponse)
async def empty_trash(
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    vector_store: QdrantVectorStore | None = Depends(get_vector_store_optional),
) -> EmptyTrashResponse:
    try:
        return await service.empty(gateway, vector_store)
    except PaperlessAuthError as e:
        raise _bad_gateway() from e


def _not_found(doc_id: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Document {doc_id} not in trash",
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
