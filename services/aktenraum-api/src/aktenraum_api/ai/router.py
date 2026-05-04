from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

import structlog
from aktenraum_core.llm import LLMBackend
from aktenraum_core.paperless import LIFECYCLE_TAGS
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ..auth.deps import get_current_user
from ..db.models import User
from ..paperless_gw import PaperlessAuthError, PaperlessGateway
from .answer_prompt import build_answer_messages, build_streaming_answer_messages
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

# Soft-failure message when the answer LLM emits structurally invalid JSON.
# The retrieval step still returned candidates, so we degrade to "couldn't
# write the prose answer, but here are the documents I found" rather than
# bouncing the whole request with a 422.
_ANSWER_LLM_FAILED_DE = (
    "Ich konnte die Antwort nicht zuverlässig formulieren. "
    "Schau bitte direkt in die unten gelisteten Dokumente."
)

# How many results to feed to the answer LLM. Personal-DMS scale; we want a
# small enough context that the prompt stays cheap, large enough that we don't
# miss the right document.
_ANSWER_CONTEXT_SIZE = 5

# Tag names the SPA shows as a status badge. Includes ai-pending so a doc
# returned by /find that's still in the inbox queue surfaces an "In Inbox"
# pill on its result card.
_LIFECYCLE_BADGE_NAMES = frozenset(LIFECYCLE_TAGS) | {"ai-low-confidence"}


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
        tag_vocab = _user_tag_vocabulary(await gateway.list_tags())
    except PaperlessAuthError as e:
        raise _bad_gateway() from e

    # Step 1 — filter extraction: same prompt the /find endpoint uses.
    messages = build_messages(
        body.question, correspondents=correspondents, tags=tag_vocab
    )
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
        # Soft-fail rather than 422 the whole request: retrieval already gave
        # us a useful set of candidate docs, so we surface them as citations
        # with a German "couldn't formulate an answer" message. Beats the
        # alternative — a raw pydantic error in the UI for an issue the user
        # cannot fix from their end (small local model leaks control tokens).
        log.warning("ai_answer_validation_failed", error=str(e))
        return AnswerResponse(
            question=body.question,
            answer_de=_ANSWER_LLM_FAILED_DE,
            citations=results[:_ANSWER_CONTEXT_SIZE],
            filter=search_filter,
            total=total,
        )

    answer_text = answer_out.answer_de.strip()
    if _is_degenerate_answer(answer_text):
        # The model echoed the schema or gave up. Treat the same as a
        # validation failure: surface the retrieved docs as citations with a
        # soft message so the user can read the source themselves.
        log.warning(
            "ai_answer_degenerate",
            answer_de=answer_text,
            cited_ids=answer_out.cited_ids,
        )
        return AnswerResponse(
            question=body.question,
            answer_de=_ANSWER_LLM_FAILED_DE,
            citations=results[:_ANSWER_CONTEXT_SIZE],
            filter=search_filter,
            total=total,
        )

    citations = _resolve_citations(answer_out.cited_ids, results)
    # If the model wrote a real answer but cited nothing, fall back to the
    # retrieved candidates so the user always has a doc to verify against —
    # the prose is only useful with a source.
    if not citations:
        citations = results[:_ANSWER_CONTEXT_SIZE]
    return AnswerResponse(
        question=body.question,
        answer_de=answer_text or _NO_MATCH_DE,
        citations=citations,
        filter=search_filter,
        total=total,
    )


@router.post("/answer/stream")
async def answer_stream(
    body: AnswerRequest,
    _user: User = Depends(get_current_user),
    gateway: PaperlessGateway = Depends(get_paperless_gateway),
    llm: LLMBackend = Depends(get_llm_backend),
    answer_llm: LLMBackend = Depends(get_answer_llm_backend),
) -> StreamingResponse:
    """SSE-streamed variant of /answer.

    Same pipeline (filter → retrieve → generate), but the generation step
    streams prose tokens as Server-Sent Events so the user sees the answer
    arrive incrementally instead of waiting 20–30s for one JSON blob. The
    answer LLM is asked to cite inline as `[Quelle: <id>]`; we regex those
    out post-hoc and intersect with the retrieved set, falling back to the
    retrieval candidates when nothing was cited.

    Event sequence (`event:` line, then `data:` JSON line, then blank):
      - `meta`     {filter, explanation, total} — sent before any prose so
                   the SPA can render the chip strip while text streams.
      - `chunk`    {text} — zero or more, delta updates. Concatenate client-
                   side. The same `chunk` event fires once with the soft-
                   fail message when the LLM stream errors out partway.
      - `final`    {citations, answer_de, total} — terminal payload with
                   the resolved citations and the full prose for archival.
      - `error`    {detail} — terminal-with-error variant when retrieval or
                   filter extraction fails before any chunk has streamed.

    Resilient to backend errors: any exception during the prose stream is
    caught, logged, and surfaced as a final `error` event so the UI can
    render a graceful fallback rather than a half-finished answer.
    """
    return StreamingResponse(
        _stream_answer_events(body, gateway, llm, answer_llm),
        media_type="text/event-stream",
        # Disable nginx response buffering on this endpoint so chunks reach
        # the browser as soon as they're emitted; the global config also
        # turns proxy_buffering off but a per-response header is the belt-
        # and-braces version.
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# Inline citation marker the streaming prompt asks the model to use:
# "Dein Pass läuft am 12.05.2030 ab. [Quelle: 17]". Captures the bare id.
_CITATION_MARKER_RE = re.compile(r"\[Quelle:\s*(\d+)\s*\]", re.IGNORECASE)


async def _stream_answer_events(
    body: AnswerRequest,
    gateway: PaperlessGateway,
    llm: LLMBackend,
    answer_llm: LLMBackend,
) -> AsyncIterator[bytes]:
    # Step 1 — filter extraction (non-streamed; cheap and we need its output
    # before we can pick candidates). Stream errors as `error` events so the
    # UI never sees a torn 5xx.
    try:
        correspondents = list((await gateway.list_correspondents()).keys())
        tag_vocab = _user_tag_vocabulary(await gateway.list_tags())
    except PaperlessAuthError:
        yield _sse("error", {"detail": "Paperless rejected the API token"})
        return

    messages = build_messages(
        body.question, correspondents=correspondents, tags=tag_vocab
    )
    try:
        search_filter = await llm.complete(messages, response_schema=SearchFilter)
    except ValidationError as e:
        log.warning("ai_filter_validation_failed", error=str(e))
        yield _sse("error", {"detail": "Filter konnte nicht extrahiert werden."})
        return

    # Step 2 — retrieval (broadened the same way the JSON answer endpoint does it).
    retrieval_filter = _broaden_for_answer(search_filter)
    try:
        results, total = await _execute_filter(gateway, retrieval_filter)
    except PaperlessAuthError:
        yield _sse("error", {"detail": "Paperless rejected the API token"})
        return

    yield _sse(
        "meta",
        {
            "filter": _filter_to_jsonable(search_filter),
            "explanation": explain_filter(search_filter),
            "total": total,
        },
    )

    if not results:
        yield _sse("chunk", {"text": _NO_MATCH_DE})
        yield _sse(
            "final",
            {"answer_de": _NO_MATCH_DE, "citations": [], "total": 0},
        )
        return

    # Step 3 — streamed prose. Accumulate so the terminal `final` event can
    # carry the full text for archival, and so post-hoc citation extraction
    # has the complete answer to scan.
    candidates = await _enrich_with_ai_fields(gateway, results[:_ANSWER_CONTEXT_SIZE])
    answer_messages = build_streaming_answer_messages(
        body.question, candidates=candidates
    )
    full_text = ""
    try:
        async for delta in answer_llm.stream_text(answer_messages):
            full_text += delta
            yield _sse("chunk", {"text": delta})
    except Exception:
        # Catch ALL exceptions, not just specific ones — at this point the
        # event stream is open and the browser is reading; we cannot raise.
        log.warning("ai_answer_stream_failed", exc_info=True)
        if not full_text:
            full_text = _ANSWER_LLM_FAILED_DE
            yield _sse("chunk", {"text": full_text})

    answer_text = full_text.strip()
    if _is_degenerate_answer(answer_text):
        log.warning("ai_answer_stream_degenerate", text=answer_text)
        full_text = _ANSWER_LLM_FAILED_DE
        # Reset the visible answer to the soft message; the SPA replaces
        # accumulated text on receipt of `final` so this lands cleanly.
        answer_text = full_text

    cited_ids = _extract_inline_citations(full_text)
    citations = _resolve_citations(cited_ids, results)
    if not citations:
        citations = results[:_ANSWER_CONTEXT_SIZE]

    yield _sse(
        "final",
        {
            "answer_de": answer_text,
            "citations": [_doc_summary_to_jsonable(c) for c in citations],
            "total": total,
        },
    )


def _extract_inline_citations(text: str) -> list[int]:
    """Pull citation ids out of `[Quelle: <id>]` markers, in first-seen order."""
    seen: set[int] = set()
    out: list[int] = []
    for match in _CITATION_MARKER_RE.finditer(text):
        try:
            value = int(match.group(1))
        except ValueError:
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _sse(event: str, payload: dict) -> bytes:
    """Encode one SSE record. Browsers parse `event:`, `data:`, blank line.

    The data line MUST be a single line — newlines in the JSON would split
    the record. `json.dumps` produces single-line output by default; the
    blank line at the end separates records.
    """
    encoded = json.dumps(payload, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {encoded}\n\n".encode()


def _filter_to_jsonable(f: SearchFilter) -> dict:
    """Pydantic SearchFilter → plain dict suitable for SSE JSON payloads."""
    return f.model_dump(mode="json")


def _doc_summary_to_jsonable(doc: DocumentSummary) -> dict:
    return doc.model_dump(mode="json")


# Field names from AnswerOutput that small models sometimes echo verbatim
# instead of producing prose. Lowercased for case-insensitive comparison.
_DEGENERATE_ANSWER_TOKENS: frozenset[str] = frozenset(
    {"answer_de", "answer", "answer de", "antwort", "string"}
)


def _is_degenerate_answer(text: str) -> bool:
    """True when the model echoed the schema instead of writing an answer.

    Trips on exact matches against known schema-echo strings, plus generic
    "no real content" cases (empty, single word that is itself a schema field
    name). Keep the check tight — false positives drop real one-word answers.
    """
    if not text:
        return True
    return text.lower().strip(" .:") in _DEGENERATE_ANSWER_TOKENS


def _broaden_for_answer(f: SearchFilter) -> SearchFilter:
    """Strip free-text from a filter when any structural field is already set.

    Q&A retrieval prefers recall: as long as document_type / correspondent /
    tags / a date bound / an amount bound exists, that's enough scope, and
    dropping the noisier `text` field avoids killing matches over conjugated
    verbs the OCR will never contain ("verlängern", "kostete", "ablaufen").
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
    ) or bool(f.tags)
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
        tag_vocab = _user_tag_vocabulary(await gateway.list_tags())
    except PaperlessAuthError as e:
        raise _bad_gateway() from e
    messages = build_messages(
        body.query, correspondents=correspondents, tags=tag_vocab
    )
    try:
        return await llm.complete(messages, response_schema=SearchFilter)
    except ValidationError as e:
        log.warning("ai_filter_validation_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"LLM emitted an invalid filter: {e.errors()}",
        ) from e


def _user_tag_vocabulary(name_to_id: dict[str, int]) -> list[str]:
    """User-facing tag names — strip the lifecycle vocabulary so the LLM
    cannot suggest internal flags as filters.
    """
    excluded = frozenset(LIFECYCLE_TAGS) | {"ai-low-confidence"}
    return [name for name in name_to_id if name not in excluded]


async def _execute_filter(
    gateway: PaperlessGateway, f: SearchFilter
) -> tuple[list[DocumentSummary], int]:
    correspondents = await gateway.list_correspondents()
    document_types = await gateway.list_document_types()
    tags = await gateway.list_tags()

    correspondent_id = correspondents.get(f.correspondent) if f.correspondent else None
    document_type_id = (
        document_types.get(f.document_type.value) if f.document_type else None
    )

    if f.correspondent and correspondent_id is None:
        f = f.model_copy(
            update={"text": (f.text + " " if f.text else "") + f.correspondent}
        )

    # Resolve tag names → ids. Unknown tag names short-circuit to zero results
    # (AND semantics: if the doc must carry a non-existent tag, nothing matches).
    tag_ids: list[int] = []
    if f.tags:
        for name in f.tags:
            tid = tags.get(name)
            if tid is None:
                return [], 0
            tag_ids.append(tid)

    params = filter_to_paperless_params(
        f,
        correspondent_id=correspondent_id,
        document_type_id=document_type_id,
        tag_ids=tag_ids,
    )
    payload = await gateway.search_documents(params)
    raw_results = payload.get("results", [])
    total_native = payload.get("count", len(raw_results))

    name_by_id = {
        "correspondents": {v: k for k, v in correspondents.items()},
        "document_types": {v: k for k, v in document_types.items()},
    }
    tag_name_by_id = {v: k for k, v in tags.items()}
    monetary_field_id = await _resolve_monetary_field_id(gateway)
    summaries = apply_post_filter(
        raw_results,
        f,
        name_by_id=name_by_id,
        monetary_field_id=monetary_field_id,
        tag_name_by_id=tag_name_by_id,
        lifecycle_tag_names=_LIFECYCLE_BADGE_NAMES,
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
