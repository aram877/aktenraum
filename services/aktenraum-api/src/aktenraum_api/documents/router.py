from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessGateway,
    PaperlessNotFoundError,
)

log = structlog.get_logger()

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("/{doc_id}/preview")
async def get_preview(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> StreamingResponse:
    return await _proxy_stream(
        gateway,
        doc_id,
        kind="preview",
        default_media_type="application/pdf",
        cache="private, max-age=300",
        forward_disposition=False,
    )


@router.get("/{doc_id}/download")
async def get_download(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> StreamingResponse:
    # The browser's Save-As dialog needs Content-Disposition; forward whatever
    # Paperless gave us so the original filename survives.
    return await _proxy_stream(
        gateway,
        doc_id,
        kind="download",
        default_media_type="application/octet-stream",
        cache="private, no-store",
        forward_disposition=True,
    )


async def _proxy_stream(
    gateway: PaperlessGateway,
    doc_id: int,
    *,
    kind: str,
    default_media_type: str,
    cache: str,
    forward_disposition: bool,
) -> StreamingResponse:
    try:
        resp = await gateway.open_document_stream(doc_id, kind)
    except PaperlessNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document {doc_id} not found",
        ) from e
    except PaperlessAuthError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        ) from e

    media_type = resp.headers.get("content-type", default_media_type)
    headers: dict[str, str] = {"Cache-Control": cache}
    if forward_disposition:
        disposition = resp.headers.get("content-disposition")
        if disposition:
            headers["Content-Disposition"] = disposition

    return StreamingResponse(
        resp.aiter_bytes(),
        media_type=media_type,
        headers=headers,
        background=BackgroundTask(resp.aclose),
    )
