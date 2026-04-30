from __future__ import annotations

import structlog
from aktenraum_core.llm import LLMBackend
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError

from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import PaperlessAuthError, PaperlessGateway
from .answer_prompt import build_answer_messages
from .deps import get_answer_llm_backend, get_llm_backend, get_paperless_gateway
from .explain import explain_filter
from .prompt import build_messages
from .schemas import (
    AnswerOutput,
    AnswerRequest,
    AnswerResponse,
    AskRequest,
    AskResponse,
    DocumentSummary,
    SearchFilter,
)
from .translate import apply_post_filter, filter_to_paperless_params

log = structlog.get_logger()

router = APIRouter(prefix="/ai", tags=["ai"])

_NO_MATCH_DE = "Ich habe keine passenden Dokumente gefunden."

# How many results to feed to the answer LLM. Personal-DMS scale; we want a
# small enough context that the prompt stays cheap, large enough that we don't
# miss the right document.
_ANSWER_CONTEXT_SIZE = 5


@router.post("/find", response_model=AskResponse)
async def find(
    body: AskRequest,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    llm: LLMBackend = Depends(get_llm_backend),
) -> AskResponse:
    """Structured-search: query → filter → result list. No prose answer.

    Branches: `query` runs the LLM filter extractor; `filter` skips the LLM.
    """
    search_filter = await _resolve_filter(body, gateway, llm)
    try:
        results, total = await _execute_filter(gateway, search_filter)
    except PaperlessAuthError as e:
        raise _bad_gateway() from e

    return AskResponse(
        filter=search_filter,
        results=results,
        explanation=explain_filter(search_filter),
        total=total,
    )


@router.post("/answer", response_model=AnswerResponse)
async def answer(
    body: AnswerRequest,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    llm: LLMBackend = Depends(get_llm_backend),
    answer_llm: LLMBackend = Depends(get_answer_llm_backend),
) -> AnswerResponse:
    """Conversational Q&A: question → filter → top matches → German prose answer.

    Two LLM calls — one to narrow the candidate set, one to generate the answer
    citing specific doc ids. The second call sees only the AI metadata
    (summary, key dates, monetary amount) of the top matches; the raw PDF
    content is intentionally kept out so the prompt stays small. RAG over PDF
    content is Phase 6.
    """
    try:
        correspondents = list((await gateway.list_correspondents()).keys())
    except PaperlessAuthError as e:
        raise _bad_gateway() from e

    # Step 1 — filter extraction: same prompt the /find endpoint uses.
    messages = build_messages(body.question, correspondents=correspondents)
    try:
        search_filter = await llm.complete(messages, response_schema=SearchFilter)
    except ValidationError as e:
        log.warning("ai_filter_validation_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"LLM emitted an invalid filter: {e.errors()}",
        ) from e

    # Step 2 — retrieval. For Q&A we broaden whenever a structural field is
    # set: the filter LLM sometimes drops question verbs ("verlängern",
    # "kosten") into `text`, which then over-constrains a search that already
    # has document_type / correspondent / dates / amounts to narrow it.
    retrieval_filter = _broaden_for_answer(search_filter)
    try:
        results, total = await _execute_filter(gateway, retrieval_filter)
    except PaperlessAuthError as e:
        raise _bad_gateway() from e

    if not results:
        return AnswerResponse(
            question=body.question,
            answer_de=_NO_MATCH_DE,
            citations=[],
            filter=search_filter,
            total=0,
        )

    # Step 3 — answer generation. Feed the AI metadata for the top N matches.
    # `answer_llm` may point at a stronger model than `llm`; the filter step
    # only needs to map question → schema, the answer step needs to actually
    # reason over the candidate fields.
    candidates = await _enrich_with_ai_fields(gateway, results[:_ANSWER_CONTEXT_SIZE])
    answer_messages = build_answer_messages(body.question, candidates=candidates)
    try:
        answer_out = await answer_llm.complete(
            answer_messages, response_schema=AnswerOutput
        )
    except ValidationError as e:
        log.warning("ai_answer_validation_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"LLM emitted an invalid answer: {e.errors()}",
        ) from e

    citations = _resolve_citations(answer_out.cited_ids, results)
    return AnswerResponse(
        question=body.question,
        answer_de=answer_out.answer_de.strip() or _NO_MATCH_DE,
        citations=citations,
        filter=search_filter,
        total=total,
    )


def _broaden_for_answer(f: SearchFilter) -> SearchFilter:
    """Strip free-text from a filter when any structural field is already set.

    Q&A retrieval prefers recall: as long as document_type / correspondent /
    a date bound / an amount bound exists, that's enough scope, and dropping
    the noisier `text` field avoids killing matches over conjugated verbs the
    OCR will never contain ("verlängern", "kostete", "ablaufen").
    """
    has_structural = any(
        v is not None
        for v in (
            f.document_type,
            f.correspondent,
            f.date_from,
            f.date_to,
            f.min_amount,
            f.max_amount,
        )
    )
    if has_structural and f.text:
        return f.model_copy(update={"text": None})
    return f


async def _resolve_filter(
    body: AskRequest, gateway: PaperlessGateway, llm: LLMBackend
) -> SearchFilter:
    if body.filter is not None:
        return body.filter
    assert body.query is not None
    try:
        correspondents = list((await gateway.list_correspondents()).keys())
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    messages = build_messages(body.query, correspondents=correspondents)
    try:
        return await llm.complete(messages, response_schema=SearchFilter)
    except ValidationError as e:
        log.warning("ai_filter_validation_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"LLM emitted an invalid filter: {e.errors()}",
        ) from e


async def _execute_filter(
    gateway: PaperlessGateway, f: SearchFilter
) -> tuple[list[DocumentSummary], int]:
    correspondents = await gateway.list_correspondents()
    document_types = await gateway.list_document_types()

    correspondent_id = correspondents.get(f.correspondent) if f.correspondent else None
    document_type_id = (
        document_types.get(f.document_type.value) if f.document_type else None
    )

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

    if f.min_amount is not None or f.max_amount is not None:
        total = len(summaries)
    else:
        total = total_native
    return summaries, total


async def _enrich_with_ai_fields(
    gateway: PaperlessGateway, results: list[DocumentSummary]
) -> list[dict]:
    """For each result, fetch the AI custom fields the answer LLM needs.

    We pull the full doc to read `ai_summary_de`, `ai_issue_date`,
    `ai_due_date`, `ai_expiry_date`, `ai_monetary_amount`,
    `ai_reference_numbers` — the metadata that lets the LLM answer most
    personal-DMS questions without seeing the PDF body.
    """
    field_id_to_name = await _custom_field_id_to_name(gateway)
    enriched: list[dict] = []
    for r in results:
        try:
            doc = await gateway.get_document(r.id)
        except Exception:
            log.warning("answer_enrich_failed", doc_id=r.id, exc_info=True)
            continue
        ai = {}
        for cf in doc.get("custom_fields") or []:
            name = field_id_to_name.get(cf.get("field"))
            if name:
                ai[name] = cf.get("value")
        enriched.append(
            {
                "id": r.id,
                "title": r.title,
                "correspondent": r.correspondent,
                "document_type": r.document_type,
                "created": r.created.isoformat() if r.created else None,
                "ai_summary_de": ai.get("ai_summary_de"),
                "ai_issue_date": ai.get("ai_issue_date"),
                "ai_due_date": ai.get("ai_due_date"),
                "ai_expiry_date": ai.get("ai_expiry_date"),
                "ai_monetary_amount": ai.get("ai_monetary_amount") or r.monetary_amount,
                "ai_reference_numbers": ai.get("ai_reference_numbers"),
            }
        )
    return enriched


def _resolve_citations(
    cited_ids: list[int], results: list[DocumentSummary]
) -> list[DocumentSummary]:
    """Intersect cited_ids with the actual searched docs (dropping hallucinations)."""
    by_id = {r.id: r for r in results}
    out: list[DocumentSummary] = []
    seen: set[int] = set()
    for cid in cited_ids:
        if cid in by_id and cid not in seen:
            out.append(by_id[cid])
            seen.add(cid)
    return out


async def _custom_field_id_to_name(gateway: PaperlessGateway) -> dict[int, str]:
    name_to_id = await gateway._get_custom_field_ids()  # noqa: SLF001
    return {fid: name for name, fid in name_to_id.items()}


_MONETARY_FIELD_NAME = "ai_monetary_amount"


async def _resolve_monetary_field_id(gateway: PaperlessGateway) -> int | None:
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


def _bad_gateway() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Paperless rejected the API token",
    )
