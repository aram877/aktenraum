## Context

Phase 2 takes the empty shell from Phase 1 and proves the core thesis of the rewrite: that an AI layer above Paperless makes the DMS feel like a smart system rather than a search box on a folder. The user types a German question; the SPA shows results plus a transparent breakdown of how the question was understood. Transparency is non-negotiable — every filter chip is editable, the explanation is in the user's words, and a click on a chip re-runs the search against Paperless without re-invoking the LLM.

The mechanism is a closed-enum filter: the LLM picks fields from a tightly bounded vocabulary (20 document types, the live list of correspondents, ISO date ranges, monetary thresholds). This keeps the prompt cheap and deterministic; even a small local model like gemma4 8B handles it once we add a few-shot block. The full RAG / embeddings approach is deliberately deferred to Phase 6 — only if structured-filter search hits a real ceiling do we add a vector store.

## Goals / Non-Goals

**Goals:**
- A logged-in user navigates to `/ask`, types a German query, hits enter, and within ~3s sees: the parsed filter, a German one-sentence explanation, and a list of matching documents.
- Every chip on the parsed filter is editable; editing it re-runs the search against Paperless directly, no LLM call needed.
- The endpoint is **stateless** — no saved queries, no caching of past asks, no analytics. Phase 5 adds saved queries; Phase 6 adds richer search.
- Server-side Paperless gateway is the single chokepoint for any Paperless call; future phases (review queue, Q&A, taxonomy) reuse it as-is.
- LLM backend selection (`anthropic` vs `ollama`) is the same env knob as the auto-tagger so deployers don't have to learn two configs.
- The full path runs end-to-end through `docker compose up -d --build`.

**Non-Goals:**
- Vector / RAG content search — Phase 6, only if needed.
- Saved queries / search history — Phase 5.
- Multi-turn conversation / clarifying questions — single-shot Q→filter for now.
- Full-text Paperless `query=` ranking improvements — we delegate ranking entirely to Paperless.
- Multi-language support — German only. The prompt and explanation are German; the codebase is bilingual but user-facing text is German.
- Streaming responses — synchronous `POST /api/ai/ask` returning the full response is fast enough at <50 docs.
- Rate limiting / abuse protection — single-user personal DMS. Add when the auth model goes multi-user.

## Decisions

### D1 — Closed-enum filter, not freeform search query

The LLM emits a `SearchFilter` Pydantic model with bounded fields:

```python
class SearchFilter(BaseModel):
    document_type: DocumentType | None    # 20-value closed enum from aktenraum-core
    correspondent: str | None              # must match a known correspondent (validated server-side)
    date_from: date | None
    date_to: date | None
    min_amount: float | None
    max_amount: float | None
    text: str | None                       # falls through to Paperless ?query=
```

Why: deterministic translation to Paperless's query string, validation kicks bad LLM output back to 422 cleanly, and the chips on the SPA map 1:1 to fields. A freeform-search-string approach would couple us to whatever Paperless's full-text search happens to support today and would defeat the chip-edit UX.

Alternative considered: SQL-like DSL ("type=Gehaltsabrechnung AND year=2023 AND amount>=3000"). Rejected — strictly more complex than the closed-enum model, with no extra power for the queries we actually want to support.

### D2 — Live correspondent list goes into the prompt; document types are hard-coded

Document types are part of `aktenraum-core`'s `DocumentType` enum (20 values, fixed-set). Correspondents are user data and grow over time, so the prompt builder fetches them via the gateway at request time and inlines them as a comma-separated list. We cache the list per-process (`CORRESPONDENT_LIST_TTL_SECONDS`, default 5 min) to avoid hitting Paperless on every keystroke.

If the user mentions a correspondent the prompt doesn't know about (e.g. just added in Paperless five seconds ago), the LLM falls back to leaving `correspondent=None` and pushing the name into `text` — Paperless's full-text search picks it up. The cache TTL means it auto-corrects on the next call.

### D3 — Translation: native filters via query string, custom fields via post-filter

Paperless's `/api/documents/?...` supports filtering by `correspondent`, `document_type`, `created__date__gte`, `created__date__lte`, `query` (full-text), and tag exclusion. We use those.

Monetary constraints (`min_amount`, `max_amount`) live on the `ai_monetary_amount` custom field, which Paperless's list endpoint does **not** support filtering on directly. So we:
1. Send the native-filter request to Paperless with a generous `page_size` (default 100).
2. Resolve each result's `ai_monetary_amount` from its `custom_fields` array.
3. Drop results that fall outside `[min_amount, max_amount]`.
4. Return the surviving results.

This is acceptable at personal-DMS scale (sub-1k docs per filter typically); the post-filter happens in-memory in <10ms. If we ever hit a query that pulls thousands of docs we add a `?ai_monetary_amount__gte=` extension to Paperless via a custom plugin, but that's not on the table now.

### D4 — Paperless API token stays server-side; the SPA never sees it

The gateway holds the token, signs every Paperless call, and returns clean JSON to the SPA. This matches the JWT-cookie auth from Phase 1: the SPA only knows about `aktenraum-api`. If we later swap Paperless for a different storage backend, the SPA doesn't change.

The token is read from `PAPERLESS_API_TOKEN` env var. If unset, AI endpoints respond 503 with `{"detail": "Paperless API token not configured"}`. Health and auth endpoints stay green. We do **not** make this fatal at startup because:
- It allows fresh installs to come up, log in, and discover the missing token via the UI rather than a crash loop.
- It's symmetric with the LLM backend (also lazy-required; missing creds → 503 on `/api/ai/*`).

### D5 — LLM backend reuses `aktenraum-core.llm.create_backend`

The auto-tagger already has the abstraction (`AnthropicBackend`, `OllamaBackend`, `LLMBackend` Protocol, `create_backend(...)` factory). We import it directly. The prompt builder produces a `list[dict]` (system + user messages); `backend.complete(messages, response_schema=SearchFilter)` does the LLM call and returns a validated `SearchFilter` instance.

The factory is built once per request via a FastAPI dependency — cheap, no shared state to worry about. If a deployer later wants connection pooling for Anthropic or Ollama we can move the factory to app-state, but YAGNI for now.

### D6 — German prompt with closed-enum, four-shot examples

System prompt structure:

1. Role: "Du bist ein Suchassistent für ein deutsches Dokumentenmanagementsystem."
2. Schema reference: the 20 document types with one-line German definitions (reused from the auto-tagger's `SYSTEM_PROMPT`).
3. Live correspondents: "Bekannte Korrespondenten: ..., ...". Truncated to 200 names if the user has more.
4. Date rules: explicit examples ("aus 2023" → date_from=2023-01-01, date_to=2023-12-31; "Q1 2024" → 2024-01-01..2024-03-31; "letzten Monat" → relative-to-today).
5. Amount rules: "über 3000€" → min_amount=3000; "unter 100€" → max_amount=100.
6. Four-shot examples covering: a year+type query, a correspondent query, an amount query, and a noisy mixed query that needs the `text` fallback.

The user message is just the raw query.

The whole prompt is in `aktenraum_api/ai/prompt.py` and gets a unit test that asserts every doc type, the date-rule keywords, and at least four "Beispiel:" markers are present. We keep the German fixed-text in the source rather than externalising to YAML — it's prompt content, not configuration.

### D7 — Editable filter chips re-run search directly, not the LLM

The SPA's response includes the parsed `SearchFilter`. When the user edits a chip, the SPA calls a sibling endpoint, `POST /api/ai/search` (or, simpler, reuses `/api/ai/ask` with a `skip_llm: true` flag). For Phase 2 we ship a single endpoint that accepts either a freeform `query` or a pre-baked `filter`:

```
POST /api/ai/ask
  body: {"query": "Lohnabrechnungen aus 2023"}
  → calls LLM, builds filter, executes, returns full response

POST /api/ai/ask
  body: {"filter": {"document_type": "Gehaltsabrechnung", "date_from": "2023-01-01", ...}}
  → skips LLM, executes filter directly, returns results + a generated explanation
```

This keeps the surface area small (one endpoint, one schema). The SPA's chip-edit flow is just "call ask with `filter` instead of `query`".

### D8 — Synchronous endpoint, no streaming

Anthropic and Ollama both support streaming, but the response payload is a structured `SearchFilter` (Pydantic JSON), not a long block of prose. Streaming a JSON object yields no UX improvement; the SPA waits ~1–3s on the LLM call and then renders. If/when we add a Q&A endpoint that returns long German prose (Phase 4) we revisit streaming there.

### D9 — Per-process correspondent cache, not Redis

We hold a `dict[str, int]` mapping correspondent name to id, with a TTL (default 300s) populated lazily. Personal-DMS scale + single API instance means one process holds the cache; multi-instance is a future concern that we'll solve when it actually exists. Cache lives on `app.state.paperless_gateway._correspondents_cache`.

### D10 — Test strategy

- **Unit tests** for translation (`SearchFilter → params dict`), post-filter (amount range), and prompt rendering. Pure functions, no I/O.
- **Router test** `tests/test_ai_router.py` with the FastAPI test client + a fake `LLMBackend` (returns a fixed `SearchFilter`) injected via dependency override + a stubbed `PaperlessGateway` that returns a fixed list of correspondents and documents. Asserts: 401 unauthenticated, 503 with empty `PAPERLESS_API_TOKEN`, 422 on invalid filter, 200 on the happy path with the expected response shape.
- **No live LLM in CI.** The fake backend replaces both Anthropic and Ollama. We rely on the auto-tagger's existing live-Ollama path being exercised by humans during development.

## Risks / Trade-offs

- **Local LLM accuracy on closed-enum classification.** gemma4 8B is good at the auto-tagger's text-classification job; the search prompt is structurally similar but has more noise (free-text user input vs. clean OCR). Mitigation: the four-shot examples target the failure modes the auto-tagger has shown (year-only dates, OCR-fragmented numbers, ambiguous correspondents). If accuracy is poor in practice we crank up `OLLAMA_MODEL` to 14B+ or fall back to Anthropic by default for this endpoint.
- **Correspondent prompt explosion.** If a user has 5000 correspondents the prompt becomes too big. Mitigation: cap the inlined list at 200 names (most-recently-used); for the rest the LLM relies on the `text` fallback. Caps are configurable.
- **Post-filter brittleness for `ai_monetary_amount`.** Documents older than the AI rollout don't have the field set; they pass the post-filter when no amount constraint is given but get dropped silently when one is. Mitigation: tests exercise this; a follow-up (Phase 5) might surface a "no amount available" state in the UI, but for now silent-drop is correct because "documents under 100€" should not return docs whose amount is unknown.
- **Prompt drift from the auto-tagger.** Two prompts now reference the 20 document types; if we ever change the taxonomy in one we must change it in both. Mitigation: the canonical list is `aktenraum_core.models.DocumentType`; both prompts iterate that enum at module load. The German one-line definitions are duplicated — a small price for keeping the prompts independently tunable.
- **No rate limiting.** A misbehaving SPA tab could spam the LLM. Single-user, localhost; we don't care today. When auth goes multi-user we add per-user rate limiting at the FastAPI middleware layer.

## Migration / Rollout

For a fresh install:
1. Operator copies the new env vars into `docker/aktenraum-api.env` (`PAPERLESS_API_TOKEN`, `LLM_BACKEND`, plus the backend-specific creds). The example file flags them as required for AI features.
2. `docker compose up -d --build aktenraum-api`.
3. Browse to `http://localhost/ask`, type a German query, observe results.

For an existing Phase-1 install:
1. Add the new env vars to `docker/aktenraum-api.env` (or copy the updated example).
2. `docker compose up -d --build aktenraum-api` (Python source change → must rebuild + recreate, not just restart).
3. The SPA is rebuilt automatically by the nginx multi-stage build picking up `apps/web/` changes.

Verification:
- `curl -s http://localhost/api/ai/ask -H "Cookie: aktenraum_session=..." -d '{"query":"test"}' -H "Content-Type: application/json"` → 200 JSON with `filter`, `results`, `explanation`.
- Browser at `/ask` shows the form, submits, renders chips and results.
- `curl -s http://localhost/api/openapi.json | jq '.paths | keys'` includes `/api/ai/ask`.
- `pnpm --filter @aktenraum/web generate:api-types` regenerates the SPA types successfully.
