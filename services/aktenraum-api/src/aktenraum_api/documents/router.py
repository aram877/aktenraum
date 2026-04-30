from __future__ import annotations

import httpx
import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessGateway,
    PaperlessNotFoundError,
)

log = structlog.get_logger()

router = APIRouter(prefix="/documents", tags=["documents"])

# Tags we strip on reprocess: every lifecycle state plus the auxiliary
# ai-low-confidence flag. After this PATCH the document looks "fresh" to the
# auto-tagger and gets re-enqueued.
_REPROCESS_REMOVE = list(LIFECYCLE_TAGS) + ["ai-low-confidence"]


class UploadResult(BaseModel):
    filename: str
    status: str  # "accepted" | "error"
    task_id: str | None = None
    detail: str | None = None


class UploadResponse(BaseModel):
    results: list[UploadResult]


class ReprocessResponse(BaseModel):
    doc_id: int
    cleared_tags: list[str]
    auto_tagger_notified: bool


@router.post("/upload", response_model=UploadResponse)
async def upload_documents(
    files: list[UploadFile] = File(...),
    title: str | None = Form(None),
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> UploadResponse:
    """Upload one or many documents into Paperless via the gateway.

    Per-file failures don't abort the batch — we collect a result per file so
    the SPA can show "3 ok, 1 failed" rather than rolling back the whole
    upload because of one bad PDF.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files supplied")

    results: list[UploadResult] = []
    for upload in files:
        try:
            content = await upload.read()
            if not content:
                results.append(
                    UploadResult(
                        filename=upload.filename or "(unknown)",
                        status="error",
                        detail="Empty file",
                    )
                )
                continue
            task_id = await gateway.upload_document(
                content=content,
                filename=upload.filename or "document",
                content_type=upload.content_type,
                title=title,
            )
            results.append(
                UploadResult(
                    filename=upload.filename or "(unknown)",
                    status="accepted",
                    task_id=task_id,
                )
            )
        except PaperlessAuthError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Paperless rejected the API token",
            ) from e
        except Exception as e:
            log.warning(
                "upload_failed",
                filename=upload.filename,
                error=str(e),
            )
            results.append(
                UploadResult(
                    filename=upload.filename or "(unknown)",
                    status="error",
                    detail=str(e),
                )
            )
    return UploadResponse(results=results)


@router.post("/{doc_id}/reprocess", response_model=ReprocessResponse)
async def reprocess(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    settings: Settings = Depends(get_settings),
) -> ReprocessResponse:
    """Send a document back through the AI pipeline.

    Two steps: clear every lifecycle tag (so the doc looks fresh to the
    auto-tagger), then ping the auto-tagger's /trigger/extract webhook so
    extraction starts immediately instead of waiting up to 30s for the
    poller. The webhook ping is best-effort — failure to reach the
    auto-tagger does NOT fail the request, because the poller will still
    pick the doc up on its next cycle.
    """
    try:
        await gateway.swap_lifecycle_tag(
            doc_id, remove=_REPROCESS_REMOVE, add=[]
        )
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

    notified = await _ping_auto_tagger(settings, doc_id)
    return ReprocessResponse(
        doc_id=doc_id,
        cleared_tags=_REPROCESS_REMOVE,
        auto_tagger_notified=notified,
    )


async def _ping_auto_tagger(settings: Settings, doc_id: int) -> bool:
    if not settings.auto_tagger_url:
        return False
    headers = {"Content-Type": "application/json"}
    if settings.webhook_secret:
        headers["X-Aktenraum-Secret"] = settings.webhook_secret
    url = f"{settings.auto_tagger_url.rstrip('/')}/trigger/extract"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                url, json={"document_id": doc_id}, headers=headers
            )
            if resp.status_code >= 400:
                log.warning(
                    "auto_tagger_ping_rejected",
                    status=resp.status_code,
                    body=resp.text[:200],
                )
                return False
            return True
    except Exception as e:
        log.warning("auto_tagger_ping_failed", error=str(e))
        return False


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
