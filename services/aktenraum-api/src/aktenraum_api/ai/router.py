from __future__ import annotations

import structlog
from aktenraum_core.llm import LLMBackend
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError

from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import PaperlessAuthError, PaperlessGateway
from .deps import get_llm_backend, get_paperless_gateway
from .explain import explain_filter
from .prompt import build_messages
from .schemas import AskRequest, AskResponse, SearchFilter
from .translate import apply_post_filter, filter_to_paperless_params

log = structlog.get_logger()

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    llm: LLMBackend = Depends(get_llm_backend),
) -> AskResponse:
    if body.filter is not None:
        search_filter = body.filter
    else:
        # query-branch: invoke the LLM, validate, fall through.
        assert body.query is not None
        try:
            correspondents = list((await _safe_list_correspondents(gateway)).keys())
        except PaperlessAuthError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Paperless rejected the API token",
            ) from e
        messages = build_messages(body.query, correspondents=correspondents)
        try:
            search_filter = await llm.complete(messages, response_schema=SearchFilter)
        except ValidationError as e:
            log.warning("ai_filter_validation_failed", error=str(e))
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"LLM emitted an invalid filter: {e.errors()}",
            ) from e

    try:
        results, total = await _execute_filter(gateway, search_filter)
    except PaperlessAuthError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paperless rejected the API token",
        ) from e

    return AskResponse(
        filter=search_filter,
        results=results,
        explanation=explain_filter(search_filter),
        total=total,
    )


async def _safe_list_correspondents(gateway: PaperlessGateway) -> dict[str, int]:
    return await gateway.list_correspondents()


async def _execute_filter(
    gateway: PaperlessGateway, f: SearchFilter
) -> tuple[list, int]:
    correspondents = await gateway.list_correspondents()
    document_types = await gateway.list_document_types()

    correspondent_id = correspondents.get(f.correspondent) if f.correspondent else None
    document_type_id = (
        document_types.get(f.document_type.value) if f.document_type else None
    )

    # If the user named a correspondent we don't know about, fall back to
    # full-text search on that name. The cache TTL means new correspondents
    # auto-populate within 5 minutes.
    if f.correspondent and correspondent_id is None:
        f = f.model_copy(
            update={"text": (f.text + " " if f.text else "") + f.correspondent}
        )

    params = filter_to_paperless_params(
        f, correspondent_id=correspondent_id, document_type_id=document_type_id
    )
    payload = await gateway.search_documents(params)
    raw_results = payload.get("results", [])
    total_native = payload.get("count", len(raw_results))

    name_by_id = {
        "correspondents": {v: k for k, v in correspondents.items()},
        "document_types": {v: k for k, v in document_types.items()},
    }
    monetary_field_id = await _resolve_monetary_field_id(gateway)
    summaries = apply_post_filter(
        raw_results,
        f,
        name_by_id=name_by_id,
        monetary_field_id=monetary_field_id,
    )

    # When amount post-filter narrowed the page, `total` reflects what we kept;
    # when no amount bound is set, fall back to Paperless's native count.
    if f.min_amount is not None or f.max_amount is not None:
        total = len(summaries)
    else:
        total = total_native
    return summaries, total


_MONETARY_FIELD_NAME = "ai_monetary_amount"


async def _resolve_monetary_field_id(gateway: PaperlessGateway) -> int | None:
    """Look up the custom-field id for ai_monetary_amount once, cached on the
    gateway instance. Returns None if the field is not configured (post-filter
    will then become a no-op for amount bounds — caller must guard separately).
    """
    cache = getattr(gateway, "_monetary_field_id", "unset")
    if cache != "unset":
        return cache
    try:
        resp = await gateway._client.get(  # noqa: SLF001 — internal cache hop
            "/api/custom_fields/", params={"page_size": 100}
        )
        resp.raise_for_status()
        for f in resp.json().get("results", []):
            if f.get("name") == _MONETARY_FIELD_NAME:
                gateway._monetary_field_id = f["id"]  # type: ignore[attr-defined]
                return f["id"]
    except Exception:
        log.warning("ai_monetary_field_lookup_failed", exc_info=True)
    gateway._monetary_field_id = None  # type: ignore[attr-defined]
    return None
