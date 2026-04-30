## Why

Phase 1 shipped the empty SPA shell on top of `aktenraum-api`. The roadmap calls for Phase 2 to be the first AI feature that justifies the rewrite: **natural-language search over Paperless**. The user types a German question ("Lohnabrechnungen aus 2023 über 3000€"), an LLM translates it into a closed-enum `SearchFilter`, the API turns that into Paperless's native query plus a post-filter for custom-field constraints, and the SPA renders editable chips + results + a German explanation of how the question was understood.

The closed-enum approach (the LLM picks from the 20-document-type taxonomy and a live list of correspondents) keeps the prompt small and deterministic; even gemma4 8B handles it. The endpoint is the foundation every later Phase reuses — Phase 3 (review queue), Phase 4 (Q&A), Phase 5 (saved queries) all consume the same Paperless gateway and translation layer landed here.

## What Changes

- **New `/api/ai/ask` endpoint** in `aktenraum-api`. Auth-gated (cookie). Accepts `{"query": str}`. Returns `{filter: SearchFilter, results: list[DocumentSummary], explanation: str}`. Filter and results are both editable / re-executable on the SPA side.
- **New `SearchFilter` Pydantic model** in `aktenraum_api.ai.schemas`: closed-enum `document_type` (reuses the 20-value `DocumentType` from `aktenraum-core`), optional `correspondent` (live list), `date_from`, `date_to`, `min_amount`, `max_amount`, `text` (free-text falls through to Paperless's full-text search). Coerced strictly — an LLM that emits an unknown document type fails validation, the endpoint returns 422 with a clear message.
- **New AI prompt builder** in `aktenraum_api.ai.prompt`: assembles a German system prompt with the 20-type closed enum, the live correspondent list (fetched from Paperless on each call, cached briefly per-process), explicit date-parsing rules ("aus 2023" → date_from=2023-01-01, date_to=2023-12-31), and 4–6 German few-shot exemplars. Designed so a small local model can hit it reliably.
- **New translator** in `aktenraum_api.ai.translate`: `SearchFilter` → Paperless query string. Document type and correspondent resolve to native ids via the gateway. Date range maps to `created__date__gte` / `created__date__lte`. Text falls through as Paperless's `query=` full-text search. Amount constraints apply as a post-filter against the `ai_total_amount` / `ai_monetary_amount` custom field on the result page.
- **New Paperless gateway** in `aktenraum_api.paperless_gw.PaperlessGateway`: a thin async client wrapping `httpx.AsyncClient`, authenticated by `PAPERLESS_API_TOKEN` server-side. Exposes `list_correspondents()`, `list_document_types()`, `search_documents(params)` with field projection (id, title, correspondent, document_type, created, custom_fields). Cached at app-state level; closed on lifespan shutdown.
- **Settings additions** to `aktenraum_api.config`:
  - `PAPERLESS_BASE_URL` (default `http://paperless:8000`)
  - `PAPERLESS_API_TOKEN` (required for AI features; service still starts without it but `/api/ai/*` returns 503 with a clear message until set)
  - `LLM_BACKEND` (`anthropic` | `ollama`)
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`)
  - `OLLAMA_BASE_URL` (default `http://host.docker.internal:11434`), `OLLAMA_MODEL`
  - `CORRESPONDENT_LIST_TTL_SECONDS` (default 300)
- **New SPA `/ask` route** in `apps/web`: search input, German placeholder ("Was suchst du?"), submit button. On submit, calls `POST /api/ai/ask` via TanStack Query mutation. Renders three regions: filter chips (editable — clicking re-runs against Paperless directly without re-asking the LLM), result list (title + correspondent + created date + chip for the document type), and an explanation panel ("Ich habe verstanden: …"). Empty / error / loading states all handled.
- **Nav entry in `AppShell`** linking the home page to `/ask`. Home stays as the empty placeholder for now (Phase 3 turns it into the inbox).
- **Compose / env wiring**: `aktenraum-api.env.example` documents the new vars. `docker-compose.yml` injects `PAPERLESS_BASE_URL=http://paperless:8000` (no need to publish via the `aktenraum` network — Paperless is already on `internal`).
- **Test coverage** in `services/aktenraum-api/tests/`:
  - `test_ai_translate.py` — `SearchFilter` → Paperless query params (every field, edge cases).
  - `test_ai_post_filter.py` — amount post-filter logic.
  - `test_ai_prompt.py` — prompt rendering covers all 20 doc types, includes the live correspondent list, date rules.
  - `test_ai_router.py` — auth-gated (401 unauthenticated, 200 authenticated), 503 when `PAPERLESS_API_TOKEN` empty, 422 when LLM emits invalid filter, success path with mocked gateway and a fake LLM backend.
- **Documentation updates**: `docs/plans/custom-frontend.md` Phase 2 → in progress; CLAUDE.md gets the new env vars and the `/api/ai/ask` reference.

## Capabilities

### New Capabilities

- `aktenraum-api/ai-search`: server-side natural-language search. Owns prompt construction, LLM call, filter validation, Paperless translation, post-filtering, and response shaping.
- `aktenraum-api/paperless-gateway`: server-side Paperless client. The Paperless API token never leaves the API container; the SPA only ever talks to `aktenraum-api`.
- `aktenraum-web/ask-page`: the user-facing "Ask AI" page that consumes `/api/ai/ask` and renders filter chips, results, and the explanation.

### Modified Capabilities

- `aktenraum-api`: gains the `/api/ai/ask` endpoint and a new env-var contract (Paperless creds, LLM backend selection).
- `aktenraum-web`: nav now exposes `/ask`; the SPA holds an editable `SearchFilter` shape.
- `aktenraum-edge`: no nginx config changes needed — `/api/ai/*` is captured by the existing `/api/` proxy block.

## Impact

- **One new server-side dependency**: `aktenraum-api` depends on `aktenraum-core` for `DocumentType` and `create_backend(...)`. Already a workspace member; no new pin.
- **Paperless API token must be present in `docker/aktenraum-api.env`** for AI features to work. Without it the `/api/ai/*` endpoints respond 503; everything else (auth, health, openapi) is unaffected.
- **LLM backend selection is per-deployment**: the same `LLM_BACKEND` env knob the auto-tagger uses, so swapping anthropic ↔ ollama is consistent across services.
- **No DB migrations** — Phase 2 is stateless (no saved queries, no analytics yet; those land in Phase 5).
- **No frontend codegen drift**: SPA reads the new `SearchFilter` and `AskResponse` types via the existing `pnpm generate:api-types` script run against `/api/openapi.json`.
- **Backward compatible**: existing endpoints, existing auth flow, existing Paperless deployment all unchanged. Operators that don't set the new env vars see the same behaviour as Phase 1.
