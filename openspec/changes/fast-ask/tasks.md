# Tasks

## 1. Baseline measurement

- [x] 1.1 Add the `ask_timing` event to the **current** `streamAnswerEvents` (D7: parse/filter-LLM, retrieval, enrich, first token, total, candidate count, reranker_used, no question text). Rebuild, ask ~10 real questions (cold and warm) and record the numbers in `openspec/changes/fast-ask/baseline.md`. Verify: one `ask_timing` line per question in `task logs SVC=aktenraum-api`, and an api test asserts the event fires once without the question.

## 2. Core: Ollama keep-alive and context

- [x] 2.1 Add a `keepAlive` option to `OllamaBackend` (`keep_alive` on streamed and structured chat requests) and to the embedder, with factory plumbing. Verify: core tests assert `keep_alive` is in the request body when set and absent when unset.
- [x] 2.2 Answer backend in `llm-backend.provider.ts`: `OLLAMA_KEEP_ALIVE` (default `-1`) and `OLLAMA_ANSWER_NUM_CTX` (default = `OLLAMA_NUM_CTX`). Document both in `docker/.env.example` + `docs/configuration.md`, including the "same model and same num_ctx avoids reloads" note. Verify: provider test covers the defaults and overrides.

## 3. API: question parser

- [x] 3.1 Implement `ai/question-parser.ts` (D2): years, relative years, month plus year, "seit"; types via `detectIntents` plus the type names and their plurals; correspondent token matching with min length, generic-token stop-list and cap 3; stop-word-stripped `text`. Verify: `question-parser.test.ts` covers every spec scenario plus the over-match cases ("Stadt", "Bank").
- [x] 3.2 `explainParsed(hints)` German one-liner for `meta.explanation`. Verify: unit test.

## 4. API: parallel retrieval and batched loading

- [x] 4.1 `RERANK_CANDIDATES` (default 20) passed as `fetchTopK` in `retrieveChunks`. Document it in configuration.md. Verify: `retrieval.test.ts` asserts the search `topK`.
- [x] 4.2 Full-text path: member-gateway `searchDocuments({query, page_size: 10})`. Structured path: built from the hints (`document_type__id__in`, `correspondent__id__in`, created dates, `ordering=-created`), run only when hints exist. Verify: service tests with the fake Paperless assert the params and that no structured call happens without hints.
- [x] 4.3 Batched candidate loading (D3): one `id__in` Paperless call for semantic-only hits, one type-fields `IN` query. Remove the per-doc `getDocument` loop. Verify: test counts fake-Paperless requests (≤ 1 document fetch per question) and type-fields queries.
- [x] 4.4 Merge and slot logic (semantic ≤ 5, then structured, then full-text, de-dup, cap `ANSWER_CONTEXT_SIZE`) and the `total` rule. Verify: pure-function tests for ordering, de-dup and cap.

## 5. API: new stream pipeline and endpoint cleanup

- [x] 5.1 Rewrite `streamAnswerEvents`: parse → `meta` → `Promise.all` of the three paths → load → `sources` → answer stream → `final`, with no filter LLM. Keep the denial gate, degenerate-answer check, citation resolution against `sources`, share-access audit and share expiry. Each path degrades on failure (vector store or embedder down → the other paths). Verify: `test/ask.routes.test.ts` covers event order, the nothing-found case, the vector-store-down case, hallucinated-citation drop, and that the fake LLM receives exactly one request.
- [x] 5.2 Tenancy: route test where member A's question matches only member B's private document (Qdrant fake and Paperless full-text), plus a shared-document case. Verify: the document is absent from `sources`, `citations` and the captured prompt for the unshared case, and present for the shared one.
- [x] 5.3 Remove `POST /api/ai/answer`, the JSON-envelope prompt paths (`toJsonEnvelope`, `jsonMode`) and their tests. Update `route-inventory.test.ts` and `docs/api-reference.md` (`/answer` removed, SSE events `meta`/`sources`/`chunk`/`final`/`error`). Verify: `pnpm --filter @aktenraum/api test` and `typecheck` are green.
- [x] 5.4 Prompt budget: a test builds the worst-case prompt (15 candidates, 5 chunks, longest summaries and type fields) and asserts an estimated token count under 8k. Verify: test green.

## 6. Web: Ask page

- [x] 6.1 `utils/sse.ts` handles `sources` (`onSources`), `StreamMeta.total` becomes nullable. `useAnswerStream` exposes `sources` and `phase` (`searching` | `answering` | `done`). Verify: unit tests for the dispatcher plus a composable test.
- [x] 6.2 `pages/ask.vue`: render source cards (DocTypeTile rows) on `sources`; status text "Suche…" / "Antwort wird geschrieben…"; on `final`, split into cited sources and "Weitere Treffer". Check light and dark mode and mobile width. Verify: `tests/nuxt/ask.spec.ts` covers sources-before-answer, the phase text and the nothing-found case.
- [x] 6.3 Settings LLM section: hint when `llm_model ≠ answer_llm_model`. Verify: nuxt test shows the hint only on a mismatch.

## 7. Integration and docs

- [x] 7.1 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api + web typecheck all green. Update the test counts in CLAUDE.md.
- [ ] 7.2 `task build`, then repeat the baseline questions from 1.1 against the live stack. Record the after-numbers next to the baseline in `baseline.md` and compare answer quality question by question. Verify: sources arrive in < 1 s warm, first token clearly faster than baseline, no quality regression the maintainer objects to.
- [x] 7.3 Run the share and removal rehearsals on the e2e stack (`share-rehearsal.mjs`, `removal-rehearsal.mjs`) since they read the stream. Verify: both pass.
- [x] 7.4 Update CLAUDE.md (Ask / streaming-answer section, retrieval order, removed `/answer`, new env vars, Known-gotcha row on `num_ctx` mismatch reloads), `docs/architecture.md` RAG section and `docs/workflow.md` if it describes Ask. Write the session note `docs/sessions/2026-11-23.md`. Verify: docs mention no filter LLM in the Ask path.

## Workflow follow-up

- Commit only after the tests are green and the maintainer has confirmed the live behaviour (per aktenraum-commit-discipline).
- Archive the change once it's live, then note it in CLAUDE.md's OpenSpec list.
