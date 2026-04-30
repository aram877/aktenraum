## 1. Settings + Config

- [ ] 1.1 Extend `services/aktenraum-api/src/aktenraum_api/config.py` with `paperless_base_url`, `paperless_api_token`, `llm_backend`, `anthropic_api_key`, `anthropic_model`, `ollama_base_url`, `ollama_model`, `correspondent_list_ttl_seconds`. All AI-related fields default to empty/zero so the service still starts without them.
- [ ] 1.2 Update `docker/aktenraum-api.env.example` with the new variables and a comment explaining `LLM_BACKEND=anthropic|ollama`.
- [ ] 1.3 Update `docker/docker-compose.yml` to inject `PAPERLESS_BASE_URL=http://paperless:8000` for the `aktenraum-api` service (override-able via env file).

## 2. Paperless Gateway (server-side)

- [ ] 2.1 Create `services/aktenraum-api/src/aktenraum_api/paperless_gw.py` with `PaperlessGateway` class wrapping `httpx.AsyncClient`. Methods: `list_correspondents()`, `list_document_types()`, `search_documents(params: dict)`, `aclose()`.
- [ ] 2.2 Add per-process correspondent cache with TTL (`_correspondents_cache: tuple[float, dict[str, int]]`).
- [ ] 2.3 Wire creation/teardown into `main.py` lifespan: build gateway on startup if `paperless_api_token` is set, attach to `app.state.paperless_gateway`, dispose on shutdown.
- [ ] 2.4 FastAPI dependency `get_paperless_gateway` that returns the gateway from app.state and raises 503 if it's None.

## 3. AI Domain — Models, Prompt, Translator

- [ ] 3.1 `aktenraum_api/ai/__init__.py` exports `router`, `SearchFilter`, `AskRequest`, `AskResponse`, `DocumentSummary`.
- [ ] 3.2 `aktenraum_api/ai/schemas.py`: `SearchFilter` (closed-enum `document_type` reusing `aktenraum_core.models.DocumentType`, plus `correspondent`, `date_from`, `date_to`, `min_amount`, `max_amount`, `text`); `DocumentSummary` (id, title, correspondent, document_type, created, monetary_amount); `AskRequest` (`query: str | None`, `filter: SearchFilter | None`, validates exactly-one); `AskResponse` (`filter`, `results`, `explanation`, `total`).
- [ ] 3.3 `aktenraum_api/ai/prompt.py`: `build_messages(query: str, *, correspondents: list[str]) -> list[dict]`. Inlines the 20 doc types with German one-line definitions, the live correspondent list (cap 200), date rules, four-shot examples. Pure function.
- [ ] 3.4 `aktenraum_api/ai/translate.py`: `filter_to_paperless_params(f: SearchFilter, *, correspondent_id: int | None, document_type_id: int | None) -> dict`; `apply_post_filter(results: list[dict], f: SearchFilter, *, name_by_id: dict[int, str]) -> list[DocumentSummary]` (handles amount post-filter and shape mapping). Pure functions.
- [ ] 3.5 `aktenraum_api/ai/explain.py`: `explain_filter(f: SearchFilter) -> str` returns a German one-sentence summary ("Ich habe verstanden: …") used both for LLM-built and SPA-edited filters.

## 4. AI Router

- [ ] 4.1 `aktenraum_api/ai/router.py` exposes `POST /api/ai/ask`. Auth-gated via `Depends(get_current_user)`. Validates `AskRequest` (one of `query`/`filter` required).
- [ ] 4.2 Branch: `query` set → fetch correspondents (cached), build prompt, call `LLMBackend.complete(messages, response_schema=SearchFilter)`, fall through to translate.
- [ ] 4.3 Branch: `filter` set → translate directly, no LLM call.
- [ ] 4.4 Translate: resolve correspondent name → id and document type → id via gateway, build params, call `gateway.search_documents(params)`, post-filter on amount, project to `DocumentSummary`.
- [ ] 4.5 Compose `AskResponse` with the filter, results, explanation, total.
- [ ] 4.6 Error mapping: gateway 401/403 from Paperless → 502 with explicit detail; LLM emits invalid filter → 422 with the validation error; gateway not configured → 503.
- [ ] 4.7 Wire `ai_router` into `create_app()` with prefix `/api`.

## 5. LLM Backend Wiring

- [ ] 5.1 `aktenraum_api/ai/deps.py`: FastAPI dependency `get_llm_backend(settings)` returns `LLMBackend` via `aktenraum_core.llm.create_backend(...)`. Raises 503 if neither `ANTHROPIC_API_KEY` (when `LLM_BACKEND=anthropic`) nor a reachable Ollama (when `LLM_BACKEND=ollama`) is configured.
- [ ] 5.2 No connection pooling for now (each request builds the backend) — document the trade-off in a code comment.

## 6. SPA — /ask Page

- [ ] 6.1 Add `apps/web/src/routes/Ask.tsx` with the search input, submit button, results list, chip row, explanation panel.
- [ ] 6.2 Add `apps/web/src/lib/ai.ts` with `ask(query: string): Promise<AskResponse>`, `searchByFilter(filter: SearchFilter): Promise<AskResponse>`, and TanStack Query `useAsk()` mutation hook.
- [ ] 6.3 Add `apps/web/src/components/FilterChips.tsx` rendering each populated field as an editable chip (click → inline edit; clear → re-run search). For Phase 2 the edit UI is "click to clear"; richer inline editors land in Phase 5.
- [ ] 6.4 Register `/ask` in `router.tsx` with the same `beforeLoad` auth guard the home route uses.
- [ ] 6.5 Update `Home.tsx` to add a nav link to `/ask`.
- [ ] 6.6 Run `pnpm --filter @aktenraum/web generate:api-types` against the running stack and commit `apps/web/src/api/types.gen.ts` (gitignored variant or committed — match the existing repo convention).

## 7. Tests

- [ ] 7.1 `services/aktenraum-api/tests/test_ai_translate.py` — `filter_to_paperless_params` covers every field, empty filter, free-text fallthrough; `apply_post_filter` covers `min_amount`, `max_amount`, both, neither, missing custom field.
- [ ] 7.2 `services/aktenraum-api/tests/test_ai_prompt.py` — rendered prompt contains every doc type, every date rule keyword, ≥4 "Beispiel:" markers, and the inlined correspondents.
- [ ] 7.3 `services/aktenraum-api/tests/test_ai_explain.py` — German explanation text covers each filter shape.
- [ ] 7.4 `services/aktenraum-api/tests/test_ai_router.py` — auth gate (401), 503 when token unset, 422 on invalid filter, 200 on happy path with mocked gateway and fake backend (filter branch + query branch).
- [ ] 7.5 Update `services/aktenraum-api/tests/conftest.py` if needed to inject the fake gateway and backend via FastAPI dependency overrides.
- [ ] 7.6 `uv run pytest` from workspace root passes the new tests alongside the existing suite.

## 8. Documentation

- [ ] 8.1 Update `docs/plans/custom-frontend.md` — Phase 2 → in progress; reference the new openspec change.
- [ ] 8.2 Update `CLAUDE.md` — list the new env vars under "Credentials & secrets"; add a paragraph under "What's implemented vs planned" for natural-language search.
- [ ] 8.3 Update `docker/aktenraum-api.env.example` comments referencing the new vars.

## 9. End-to-End Verification

- [ ] 9.1 `docker compose up -d --build aktenraum-api nginx`. All services healthy.
- [ ] 9.2 Browser: log in, navigate to `/ask`, submit "Rechnungen von Telekom aus 2024". Expect non-empty response with filter chips, results, explanation.
- [ ] 9.3 Edit a chip (clear correspondent), expect a re-run that produces a wider result set.
- [ ] 9.4 `curl -s http://localhost:8080/api/openapi.json | jq '.paths["/api/ai/ask"]'` shows the new endpoint.
- [ ] 9.5 Negative path: temporarily clear `PAPERLESS_API_TOKEN`, restart `aktenraum-api`, submit a query, observe 503 with the "Paperless API token not configured" message rendered as an inline error in the SPA.
