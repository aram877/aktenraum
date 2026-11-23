# Design

## Context

Today's `/api/ai/answer/stream` (`ai.controller.ts` `streamAnswerEvents`) runs strictly in sequence:

1. Load the prompt context (correspondents and tags from Paperless).
2. **Filter LLM** (`llmBackends.build("filter")`: the `app_settings.llm_model` tag, currently `gemma4:26b`, which is also the worker's extraction model). It returns a JSON `SearchFilter`.
3. `executeFilter` runs a Paperless search with the broadened filter.
4. `retrieveChunks`: embed (`qwen3-embedding:4b`), search Qdrant for the top 50, rerank on the CPU in batches of 8, keep the top 5.
5. `promotePromptResults`, then `enrichWithAiFields`: one `getDocument` per candidate (up to 15) plus one type-fields DB read per candidate, all sequential.
6. **Answer LLM** stream (`answer_llm_model`, currently `qwen2.5:14b-instruct-q8_0`, `num_ctx` 24576).

The two chat models together need more than the 24 GB of VRAM, so steps 2 and 6 evict each other and the embedder. The cold loads measured on 2026-11-23 were 56 s and 40 s (see proposal.md, Why). Member Paperless calls already go through `MemberGateways.forPrincipal`, so Paperless enforces tenancy on Paperless-side searches. Qdrant searches are scoped through `TenancyService.searchAccess`.

## Goals / Non-Goals

**Goals:**
- One LLM call per question, and no LLM before retrieval.
- Independent work runs concurrently, with a bounded number of round-trips (no per-candidate Paperless calls).
- Show the user something useful (sources) as soon as retrieval is done.
- Timings are measurable per stage, so later tuning is evidence-based.

**Non-Goals:**
- Sparse or hybrid vectors in Qdrant (`rag-phase-1` keeps them planned; Paperless full-text plays the lexical role here).
- Moving the reranker to the GPU, or a different reranker model.
- Changing extraction, the worker or the Qdrant payload. No re-index.
- Multi-turn conversation or chat history.
- Changing `/api/ai/find` (it keeps its LLM filter; it is backend-only and unused).

## Decisions

### D1 — Drop the filter LLM; retrieval first with three parallel paths
After a synchronous parse (D2), the pipeline starts in one `Promise.all`:
- **semantic**: embed, Qdrant search, rerank (scoped by `searchAccess`; the Qdrant filter uses parsed doc types and correspondents only when D2 found them, with the existing "retry unfiltered if empty" behaviour)
- **full-text**: Paperless `query=<question stripped of stop words>` through the member gateway, `page_size` 10
- **structured**: only when D2 produced hints. A Paperless filtered search (`document_type__id__in`, `correspondent__id`, `created__date__gte/lte`) with `ordering=-created`, `page_size` = `ANSWER_CONTEXT_SIZE`. This keeps aggregation questions ("wie viel … 2025") working: they need *all* bills of the year, not the top 5 chunks.

The candidates are merged into prompt slots in this order: semantic (≤ 5, reranked), then structured, then full-text, de-duplicated and capped at `ANSWER_CONTEXT_SIZE` (15). `total` = the structured total when hints exist, otherwise the number of distinct candidates.

*Alternatives*: keep the filter LLM but make it small and resident. That still costs ~0.5–2 s and VRAM, and a wrong guess still distorts the results. Or semantic search only: it loses pending and unindexed documents and lexical matches (reference numbers, names). Rejected both.

### D2 — Deterministic question parser (`ai/question-parser.ts`)
A pure function `parseQuestion(question, {correspondents, now}) → {dateFrom?, dateTo?, docTypes[], correspondents[], text}`:
- **Dates**: a four-digit year 1990–2099; "letztes / vorletztes / dieses Jahr"; a German month name plus a year; "seit <year>"
- **Types**: the existing `detectIntents` + `docTypesForIntents` (`ai/intent.ts`), plus a direct match on the 27 type names and common plurals ("Rechnungen")
- **Correspondents**: case-insensitive token match against the known names. Each name is reduced to its distinctive tokens: words of length ≥ 4, without legal-form suffixes like GmbH/AG/SE/e.V. One distinctive token in the question is a hit. Capped at 3 matches, so an ambiguous question doesn't over-narrow.
- `text`: the question without German stop words, for the full-text path.

The correspondent list comes from the gateway's cached `listCorrespondents()` (the 5-minute entity cache), so the parse costs no round-trip after the first request.

### D3 — Batched candidate loading
`enrichWithAiFields` is replaced by:
- one `gateway.searchDocuments({ id__in: ids, page_size: ids.length })` (the list response includes `custom_fields`)
- one `typeFields` query `WHERE doc_id IN (…)`
- name maps from the cached entity lists

The structured and full-text paths already return full document rows, so their candidates need no second fetch. Only semantic-only hits are loaded. The cost goes from up to 30 sequential round-trips to at most two.

*Alternative*: store `ai_summary_de` and the type fields in the Qdrant payload. It saves one more call, but edits to the AI fields in the library would leave the payload stale (today the payload is only refreshed on star/unstar), and every chunk would carry a copy. Rejected for now. The batched call is about 100–300 ms.

### D4 — SSE contract: `meta` → `sources` → `chunk`* → `final`
- `meta` is sent right after the parse (< 50 ms) with `{filter, explanation, total: null}`. The explanation is built from the parsed hints ("2025 · Rechnung · Vattenfall").
- `sources` (new) carries `DocumentSummary[]`, the prompt candidates in prompt order, plus the final `total`.
- `final` is unchanged in shape.

The SPA renders source cards on `sources` and moves them to "Zitiert" or "Weitere Treffer" on `final`. Old clients ignore unknown events, so the rehearsal scripts keep working.

### D5 — Rerank fewer candidates
`fetchTopK` comes from `RERANK_CANDIDATES` (default 20). The reranker's cost is linear in the number of pairs (batches of 8 on the CPU), so it drops from ~2.5 s to ~1 s. `RERANKER_ENABLED=false` keeps working.

### D6 — Keep the answer model resident; separate context size
`OllamaBackend` gains `keepAlive?: string | number`, sent as top-level `keep_alive` on chat requests (streamed and structured). The api's answer backend gets `keep_alive = OLLAMA_KEEP_ALIVE` (default `-1`) and `num_ctx = OLLAMA_ANSWER_NUM_CTX` (default = `OLLAMA_NUM_CTX`).

Ollama reloads a model whenever `num_ctx` differs from the loaded instance. So when the extraction and answer models are the same tag, both sides must use the same `num_ctx`, which is why that is the default. The prompt is held within budget by capping chunk text per candidate and summaries at the existing lengths. A test asserts that the worst case stays under ~8k tokens, so an operator who runs a dedicated answer model can lower `OLLAMA_ANSWER_NUM_CTX` to 8192.

The settings hint (spec) is SPA-only: compare `llm_model` and `answer_llm_model` from the existing `GET /api/settings/llm` and `/answer-llm`.

The embedder gets the same `keep_alive`. At 2.5 GB it fits next to one ~20 GB model.

### D7 — `ask_timing` instrumentation
`performance.now()` marks at: parse done, retrieval done (per path), candidates loaded, first token, end. One `logger.info("ask_timing", {...})` in a `finally`. The question text is not logged (privacy).

### D8 — Remove `POST /api/ai/answer`
Its controller method, the JSON-envelope prompt path (`toJsonEnvelope`, `jsonMode` in `assembledExamples`) and its tests are removed. The route inventory test is updated. `buildMessages` and the filter schema stay because `/find` uses them.

## Risks / Trade-offs

- [Without the LLM filter, natural phrasings like "meine letzte Gehaltsabrechnung" are no longer translated to `ordering=-created, type=Gehaltsabrechnung, page_size=1`] → The parser maps "Gehaltsabrechnung" to the type, structured search orders by `-created`, so the newest one is the first slot. "letzte" needs no special handling.
- [Paperless full-text search on a long question may return noise] → Stop words are stripped, the result is capped at 10, and it fills the lowest slots after the semantic and structured candidates.
- [Correspondent token matching can over-match common words (e.g. "Stadt")] → Minimum token length, a short stop-list of generic tokens (stadt, bank, versicherung, deutsche, gmbh…), a cap of 3, and hints only narrow the *structured* path (spec).
- [Keeping the answer model resident permanently holds ~20 GB of VRAM] → It is the operator's choice via `OLLAMA_KEEP_ALIVE` (e.g. `30m`). Documented in configuration.md.
- [Different extraction and answer models still swap during uploads] → The settings hint makes this visible. Using one model for both is recommended in docs/configuration.md.
- [The eval harness (`run-rag-eval.sh`) measures retrieval only] → Unchanged. A manual before/after check of ~10 real questions (timing and answer quality) is part of the tasks.

## Migration Plan

1. Deploy with `task build`. No schema, payload or env change is required (all new env vars have defaults).
2. Recommended operator step (not automated): set the extraction and answer models to the same tag in `/settings`.
3. Rollback: revert the commit and rebuild. No data was changed.
