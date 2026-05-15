from __future__ import annotations

import httpx
import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from ..ai.deps import get_paperless_gateway
from ..auth.deps import get_current_user, get_settings
from ..config import Settings
from ..db.models import User
from ..db.session import get_session
from ..inbox import schemas as inbox_schemas
from ..inbox import service as inbox_service
from ..paperless_gw import (
    PaperlessAuthError,
    PaperlessGateway,
    PaperlessNotFoundError,
)

log = structlog.get_logger()

router = APIRouter(prefix="/documents", tags=["documents"])

# Tags we strip on reprocess: every lifecycle state plus the auxiliary
# ai-low-confidence and ai-auto-approved flags. After this PATCH the
# document looks "fresh" to the auto-tagger and gets re-enqueued.
_REPROCESS_REMOVE = list(LIFECYCLE_TAGS) + ["ai-low-confidence", "ai-auto-approved"]

# Tag names the SPA renders as status badges, including ai-pending so the
# upload-progress poller can distinguish "landed in inbox" from "still
# classifying". Library lists already exclude pending docs server-side, so
# this set being permissive doesn't leak pending docs into /library.
# `ai-auto-approved` is auxiliary but joined here so the ProcessingBadge can
# render an "Auto-genehmigt" pill wherever a doc card appears.
_BADGE_TAG_NAMES = frozenset(LIFECYCLE_TAGS) | {"ai-low-confidence", "ai-auto-approved"}

# A doc counts as "in flight" when it has no terminal lifecycle tag yet.
# Concretely: it has ai-pending (still in the inbox queue), ai-approved
# (about to propagate), or no AI tag at all (just landed / poller hasn't
# enqueued yet). Those are the rows the Nav badge counts.
_IN_FLIGHT_TAGS = frozenset({"ai-pending", "ai-approved"})


class DocumentStatus(BaseModel):
    id: int
    lifecycle_tags: list[str]


class TaskStatus(BaseModel):
    """Projection of Paperless's `/api/tasks/?task_id=…` response.

    Paperless surfaces the per-upload pipeline state here. We expose only the
    fields the SPA needs so a slimmer change in upstream doesn't ripple
    through. `doc_id` is parsed from `related_document` if present, otherwise
    from the `result` text ("Success. New document id 19 created").
    """

    task_id: str
    status: str  # PENDING | STARTED | SUCCESS | FAILURE
    doc_id: int | None = None
    result: str | None = None


class InFlightCount(BaseModel):
    count: int


class ProcessingState(BaseModel):
    """Live snapshot of doc ids the auto-tagger is currently handling.

    `processing` is the deduped union the SPA actually polls. `slots`
    breaks it down per pipeline stage (extraction / propagation /
    indexer) for ops and the upload page's verbose status line.
    """

    processing: list[int]
    slots: dict[str, int | None]


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


@router.get("/{doc_id}/detail", response_model=inbox_schemas.InboxDetail)
async def get_document_detail(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    session: AsyncSession = Depends(get_session),
) -> inbox_schemas.InboxDetail:
    """Full review payload for any document (not just pending).

    Same shape as `GET /api/inbox/{id}` so the SPA can reuse the form
    component. Library detail / preview pages call this; the inbox endpoint
    stays in place for the existing review-queue UI.
    """
    try:
        return await inbox_service.get_detail(gateway, doc_id, session=session)
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


@router.patch("/{doc_id}/fields", response_model=inbox_schemas.InboxDetail)
async def patch_document_fields(
    doc_id: int,
    body: inbox_schemas.InboxFieldUpdate,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> inbox_schemas.InboxDetail:
    """Partial update of the AI custom fields on any document.

    Routes through the same boundary normalisers as the inbox PATCH so user
    edits made from the library page can't trip Paperless's date / monetary /
    string-length validation. Does NOT rewrite native Paperless fields
    (correspondent FK, document_type FK, created_date) — the propagator only
    runs on ai-approved docs. To rewrite natives too, the user hits
    "Erneut verarbeiten" which clears lifecycle and re-runs the pipeline.
    """
    try:
        return await inbox_service.apply_field_update(gateway, doc_id, body)
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


@router.get("/processing", response_model=ProcessingState)
async def get_processing_state(
    _user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> ProcessingState:
    """Which doc(s) is the auto-tagger working on right now?

    The Nav-badge `/in-flight` count is a lagging signal — it includes
    every ai-pending / ai-approved doc, not just the one being processed
    this second. This endpoint hits the auto-tagger's internal HTTP
    listener (port 8001 inside the network) for its in-memory
    ProcessingState. The SPA polls it so the per-row "Wartet auf KI"
    badge can flip to a spinner on the specific doc the worker is on.

    Best-effort: when the auto-tagger isn't reachable (down, restarted,
    not configured), return empty slots rather than raising — the
    badges fall back to their pre-feature behavior.
    """
    empty = ProcessingState(
        processing=[],
        slots={"extraction": None, "propagation": None, "indexer": None},
    )
    if not settings.auto_tagger_url:
        return empty
    url = f"{settings.auto_tagger_url.rstrip('/')}/processing"
    headers: dict[str, str] = {}
    if settings.webhook_secret:
        headers["X-Aktenraum-Secret"] = settings.webhook_secret
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            log.warning(
                "auto_tagger_processing_unexpected_status",
                status=resp.status_code,
            )
            return empty
        body = resp.json()
    except Exception as exc:
        log.info("auto_tagger_processing_unreachable", error=str(exc))
        return empty
    return ProcessingState(
        processing=[int(i) for i in body.get("processing") or []],
        slots=body.get("slots")
        or {"extraction": None, "propagation": None, "indexer": None},
    )


@router.get("/in-flight", response_model=InFlightCount)
async def in_flight_count(
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> InFlightCount:
    """Count documents currently being processed (Nav badge data source).

    Definition of "in flight": carries `ai-pending` (review queue) or
    `ai-approved` (waiting for the propagation watcher). Docs with no
    lifecycle tag at all are intentionally excluded — they could be legacy
    pre-AI uploads, and counting them would make the badge always >0 on
    older installs.
    """
    try:
        tags = await gateway.list_tags()
        flight_ids = [tags[name] for name in _IN_FLIGHT_TAGS if name in tags]
        if not flight_ids:
            return InFlightCount(count=0)
        # Paperless's tags__id__in is comma-separated list — returns docs that
        # carry ANY of the listed tag ids.
        payload = await gateway.search_documents(
            {"tags__id__in": ",".join(str(i) for i in flight_ids)},
            page_size=1,
        )
    except PaperlessAuthError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        ) from e
    return InFlightCount(count=int(payload.get("count", 0)))


@router.get("/task/{task_id}", response_model=TaskStatus)
async def get_task_status(
    task_id: str,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    settings: Settings = Depends(get_settings),
) -> TaskStatus:
    """Look up a Paperless consumer task by uuid (post-upload pipeline)."""
    # Use the gateway's authenticated httpx client directly — task lookup is
    # a one-line proxy and doesn't justify yet another gateway method.
    resp = await gateway._client.get(  # noqa: SLF001
        "/api/tasks/", params={"task_id": task_id}
    )
    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        )
    resp.raise_for_status()
    rows = resp.json() if isinstance(resp.json(), list) else []
    if not rows:
        # Paperless prunes finished tasks after a TTL; return UNKNOWN so the
        # SPA can stop polling without raising.
        return TaskStatus(task_id=task_id, status="UNKNOWN")
    row = rows[0]
    return TaskStatus(
        task_id=task_id,
        status=str(row.get("status") or "UNKNOWN").upper(),
        doc_id=_extract_doc_id(row),
        result=row.get("result"),
    )


@router.get("/{doc_id}/status", response_model=DocumentStatus)
async def get_document_status(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> DocumentStatus:
    """Lightweight lifecycle-tag lookup for upload polling.

    Returns just `{id, lifecycle_tags}` so the SPA can poll quickly without
    pulling the full doc payload. Pairs with `/task/{uuid}` after Paperless
    finishes consuming.
    """
    try:
        doc = await gateway.get_document(doc_id)
        tags = await gateway.list_tags()
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
    tag_id_to_name = {v: k for k, v in tags.items()}
    lifecycle = [
        name
        for tid in (doc.get("tags") or [])
        if (name := tag_id_to_name.get(tid)) and name in _BADGE_TAG_NAMES
    ]
    return DocumentStatus(id=doc_id, lifecycle_tags=lifecycle)


def _extract_doc_id(task_row: dict) -> int | None:
    """Pull the resulting Paperless doc id from a task row.

    Paperless's `related_document` is the canonical field but isn't always
    populated (older versions, FAILURE rows). Falls back to parsing the
    `result` string ("Success. New document id 19 created") so the SPA gets
    a usable id even on older Paperless.
    """
    related = task_row.get("related_document")
    if isinstance(related, int):
        return related
    result = task_row.get("result") or ""
    import re

    match = re.search(r"document id (\d+)", result)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


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


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    doc_id: int,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
) -> None:
    """Permanently remove a document from Paperless.

    No soft-delete: the PDF, OCR, custom fields, and any Qdrant chunks for
    the doc are gone. The SPA wraps this in a confirm step; on success it
    invalidates the library / inbox / in-flight caches so the row disappears.
    """
    try:
        await gateway.delete_document(doc_id)
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
