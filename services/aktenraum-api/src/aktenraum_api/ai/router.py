from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

import structlog
from aktenraum_core.llm import LLMBackend
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType
from aktenraum_core.paperless import LIFECYCLE_TAGS
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user
from ..db.models import User
from ..db.session import get_session
from ..paperless_gw import PaperlessAuthError, PaperlessGateway
from ..type_fields import service as type_fields_service
from .answer_prompt import build_answer_messages, build_streaming_answer_messages
from .deps import (
    get_answer_llm_backend,
    get_llm_backend,
    get_paperless_gateway,
    get_retrieval_deps,
)
from .explain import explain_filter
from .prompt import build_messages
from .retrieval import RetrievalDeps, RetrievedChunk, retrieve_chunks_for_question
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
_LIFECYCLE_BADGE_NAMES = frozenset(LIFECYCLE_TAGS) | {
    "ai-low-confidence",
    "ai-auto-approved",
}


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
    session: AsyncSession = Depends(get_session),
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
    retrieval_filter = await _broaden_for_answer(search_filter, gateway)
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
    candidates = await _enrich_with_ai_fields(
        gateway, results[:_ANSWER_CONTEXT_SIZE], session=session
    )
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
    retrieval_deps: RetrievalDeps | None = Depends(get_retrieval_deps),
    session: AsyncSession = Depends(get_session),
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
        _stream_answer_events(
            body, gateway, llm, answer_llm, retrieval_deps, session=session
        ),
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

# Max number of chunks per doc rendered into the prompt. The reranker
# returns up to `rag_rerank_top_k` (5) chunks total across all docs, so
# in practice this cap mostly matters when the same doc dominates the
# result set. Three is enough context to read; more is just budget burn.
_MAX_CHUNKS_PER_DOC_IN_PROMPT = 3


def _ranked_unique_doc_ids(chunks: list[RetrievedChunk]) -> list[int]:
    """Dedupe doc ids while preserving the reranker's order."""
    seen: set[int] = set()
    out: list[int] = []
    for c in chunks:
        if c.doc_id in seen:
            continue
        seen.add(c.doc_id)
        out.append(c.doc_id)
    return out


def _group_chunks_by_doc(
    chunks: list[RetrievedChunk],
) -> dict[int, list[str]]:
    """Bucket chunks by doc_id, keeping rank order, capped per doc.

    With reranker top-5 the same doc rarely contributes more than two
    chunks; the cap is here for the edge case where a long contract
    sweeps the top-K and would otherwise crowd out other docs in the
    prompt.
    """
    by_doc: dict[int, list[str]] = {}
    for c in chunks:
        bucket = by_doc.setdefault(c.doc_id, [])
        if len(bucket) < _MAX_CHUNKS_PER_DOC_IN_PROMPT:
            bucket.append(c.text)
    return by_doc


async def _reorder_or_fetch(
    structural_results: list[DocumentSummary],
    rag_doc_ids: list[int],
    gateway: PaperlessGateway,
) -> list[DocumentSummary]:
    """Match RAG's doc-id ordering against the structural results;
    fetch any RAG doc that wasn't in the structural set so it can
    still appear as a citation.

    RAG and structural retrieval narrow on different signals (semantic
    similarity vs. closed-enum payload match), so the two sets only
    partially overlap. Without this step a chunk-level retrieval hit
    would have no DocumentSummary for the SPA to render as a citation.
    Capped at `_ANSWER_CONTEXT_SIZE` so the answer prompt never grows
    unbounded.
    """
    by_id = {r.id: r for r in structural_results}
    out: list[DocumentSummary] = []
    for doc_id in rag_doc_ids[:_ANSWER_CONTEXT_SIZE]:
        if doc_id in by_id:
            out.append(by_id[doc_id])
            continue
        # RAG-only doc — fetch a minimal DocumentSummary via the
        # PaperlessGateway. Best-effort: if the fetch fails we skip the
        # doc rather than crash the whole answer.
        try:
            doc = await gateway.get_document(doc_id)
            out.append(_doc_to_summary(doc))
        except Exception:
            log.warning("rag_doc_summary_fetch_failed", doc_id=doc_id)
            continue
    return out


def _doc_to_summary(doc: dict) -> DocumentSummary:
    """Project a raw Paperless doc dict into the SPA-facing summary shape —
    same projection `_execute_filter` does, minus the custom-fields read
    (the reranker already used the body)."""
    from datetime import date as _date

    created_raw = doc.get("created_date") or doc.get("created")
    created: _date | None = None
    if isinstance(created_raw, str):
        try:
            created = _date.fromisoformat(created_raw[:10])
        except ValueError:
            created = None
    return DocumentSummary(
        id=doc["id"],
        title=doc.get("title") or f"Dokument #{doc['id']}",
        original_file_name=doc.get("original_file_name"),
        correspondent=None,
        document_type=None,
        created=created,
        lifecycle_tags=[],
    )


async def _stream_answer_events(
    body: AnswerRequest,
    gateway: PaperlessGateway,
    llm: LLMBackend,
    answer_llm: LLMBackend,
    retrieval_deps: RetrievalDeps | None = None,
    *,
    session: AsyncSession | None = None,
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
    retrieval_filter = await _broaden_for_answer(search_filter, gateway)
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

    # Step 3a — RAG retrieval (Phase 1.9). When QDRANT_URL is set, the
    # answer LLM gets the actual document body chunks alongside the AI
    # metadata fields it already saw. This is the difference between
    # "could only answer questions about dates and amounts" and "can
    # answer questions about anything in the document text". When RAG
    # is disabled or returns nothing, the prompt falls back to the
    # AI-metadata-only path so the existing behaviour is preserved.
    rag_chunks: list[RetrievedChunk] = []
    if retrieval_deps is not None:
        rag_chunks = await retrieve_chunks_for_question(
            body.question,
            deps=retrieval_deps,
            structural_filter=search_filter,
        )

    # Step 3b — pick which docs make it into the prompt. With RAG, the
    # reranker has already picked the top-N most relevant chunks; we
    # use those docs as candidates (deduped by doc_id, preserving rank
    # order). Without RAG, fall back to the structural retrieval order.
    rag_doc_ids = _ranked_unique_doc_ids(rag_chunks)
    if rag_doc_ids:
        prompt_results = _reorder_or_fetch(results, rag_doc_ids, gateway)
        prompt_results = await prompt_results
    else:
        prompt_results = results[:_ANSWER_CONTEXT_SIZE]

    # Step 3c — streamed prose. Accumulate so the terminal `final` event
    # can carry the full text for archival, and so post-hoc citation
    # extraction has the complete answer to scan.
    candidates = await _enrich_with_ai_fields(
        gateway, prompt_results, session=session
    )
    chunks_by_doc = _group_chunks_by_doc(rag_chunks)
    answer_messages = build_streaming_answer_messages(
        body.question, candidates=candidates, chunks_by_doc=chunks_by_doc
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
    # Look up citations against the union of structural results and
    # RAG-promoted prompt_results. Without the union, an answer that
    # cites a RAG-only doc would silently drop the citation because
    # `results` doesn't include it.
    citation_pool: list[DocumentSummary] = list(results)
    structural_ids = {r.id for r in results}
    for doc in prompt_results:
        if doc.id not in structural_ids:
            citation_pool.append(doc)
    citations = _resolve_citations(cited_ids, citation_pool)
    if not citations:
        # Prefer the RAG-promoted set when available — those are the
        # docs the answer actually drew from. Fall back to structural
        # top-N when RAG was off.
        citations = (
            prompt_results[:_ANSWER_CONTEXT_SIZE]
            if prompt_results
            else results[:_ANSWER_CONTEXT_SIZE]
        )

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


async def _broaden_for_answer(
    f: SearchFilter, gateway: PaperlessGateway
) -> SearchFilter:
    """Q&A retrieval prefers recall, so massage the LLM-extracted filter
    before it hits Paperless.

    Two corrections:

    1. **Strip ALL tags.** The filter LLM over-eagerly adds tag names on
       natural-language questions ("Wie viel habe ich verdient?" →
       tags=[Arbeitslohn, Gehalt, Gehaltszettel, Verdienstabrechnung]).
       `_execute_filter` uses AND semantics, so the target doc has to
       carry every one of those tags or it's filtered out — and the
       auto-tagger only assigns the suggested tags it itself emitted at
       extraction time, so two docs about salary often have different
       tag sets. Tags add nothing the structural fields
       (document_type / correspondent / dates) and RAG retrieval don't
       already provide here; on /ask they are pure narrowing hazard. /find
       is unaffected — it keeps strict tag semantics for the chip UI.

    2. **Strip free-text when structural scope already exists.** As long
       as document_type / correspondent / a date bound is set, that's
       enough narrowing, and dropping the noisier `text` field avoids
       killing matches over conjugated verbs the OCR will never contain
       ("verlängern", "kostete", "verdient").
    """
    updates: dict = {}

    if f.tags:
        log.info("ai_answer_tags_stripped", tags=f.tags)
        updates["tags"] = []

    has_structural = any(
        v is not None
        for v in (
            f.document_type,
            f.correspondent,
            f.date_from,
            f.date_to,
        )
    )
    if has_structural and f.text:
        updates["text"] = None

    # `gateway` accepted for future hooks (e.g. resolving correspondent
    # synonyms); not used by the current strip-only path.
    del gateway

    return f.model_copy(update=updates) if updates else f


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
    # Resolve ai_error_message id so apply_post_filter can surface it on each
    # DocumentSummary. Defence-in-depth None when the field is missing — older
    # installs that haven't re-run bootstrap-paperless.sh.
    error_field_id = (await gateway._get_custom_field_ids()).get(  # noqa: SLF001
        "ai_error_message"
    )
    summaries = apply_post_filter(
        raw_results,
        f,
        name_by_id=name_by_id,
        tag_name_by_id=tag_name_by_id,
        lifecycle_tag_names=_LIFECYCLE_BADGE_NAMES,
        error_field_id=error_field_id,
    )
    return summaries, total_native


async def _enrich_with_ai_fields(
    gateway: PaperlessGateway,
    results: list[DocumentSummary],
    *,
    session: AsyncSession | None = None,
) -> list[dict]:
    """For each result, fetch the metadata the answer LLM needs.

    Three layers per candidate:

      1. The structural fields off the DocumentSummary (id, title, type,
         correspondent, created).
      2. The Paperless `ai_*` custom fields — `ai_summary_de`,
         `ai_issue_date`, `ai_reference_numbers`. Same data the SPA shows
         in the inbox/library review form.
      3. The type-specific (pass-2) fields stored in the aktenraum DB —
         `bruttogehalt`/`nettogehalt` for Gehaltsabrechnung,
         `gesamtbetrag` for Rechnung, etc. Without these the answer LLM
         has no money figures to read for the most common personal-DMS
         questions ("Wie viel habe ich verdient?", "Was hat die
         Versicherung gekostet?"). Pre-Phase-2 the comment here said
         monetary lived only in RAG chunks; that meant the LLM saw
         numbers only when retrieval happened to hit the right span. Now
         we surface them directly when the row exists.

    `session` is optional so unit tests for the structural path don't
    need a DB. When `session is None` the type-specific layer is skipped.
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

        type_specific = await _load_type_specific_fields(
            session, r.id, r.document_type
        )

        enriched.append(
            {
                "id": r.id,
                "title": r.title,
                "correspondent": r.correspondent,
                "document_type": r.document_type,
                "created": r.created.isoformat() if r.created else None,
                "ai_summary_de": ai.get("ai_summary_de"),
                "ai_issue_date": ai.get("ai_issue_date"),
                "ai_reference_numbers": ai.get("ai_reference_numbers"),
                "type_specific_fields": type_specific,
            }
        )
    return enriched


async def _load_type_specific_fields(
    session: AsyncSession | None,
    doc_id: int,
    document_type: str | None,
) -> list[dict]:
    """Return [{name, label, value}, ...] for the pass-2 fields stored on
    this doc. Empty list if no session, no row, no schema match, or no
    populated fields. Resolves the German `label` from `TYPE_FIELD_SCHEMA`
    so the answer prompt gets a human-readable name ("Bruttogehalt"
    rather than `bruttogehalt`).
    """
    if session is None or not document_type:
        return []
    try:
        doc_type_enum = DocumentType(document_type)
    except ValueError:
        return []
    schema = TYPE_FIELD_SCHEMA.get(doc_type_enum) or []
    if not schema:
        return []
    try:
        row = await type_fields_service.get(session, doc_id)
    except Exception:
        log.warning("answer_enrich_type_fields_failed", doc_id=doc_id, exc_info=True)
        return []
    if row is None or not row.fields:
        return []
    label_by_name = {f.name: f.label for f in schema}
    out: list[dict] = []
    for name, value in row.fields.items():
        if value in (None, ""):
            continue
        label = label_by_name.get(name, name)
        out.append({"name": name, "label": label, "value": value})
    return out


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


def _bad_gateway() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Paperless rejected the API token",
    )
