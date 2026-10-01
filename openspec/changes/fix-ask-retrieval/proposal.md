## Why

The 2026-10-01 review found that Ask often never uses the document body, which is the point of RAG Phase 1:

- the stream answers "nicht gefunden" before RAG runs whenever the structured filter returns zero documents (e.g. the filter LLM guesses `Zeugnis` for a CV filed as `Sonstiges`);
- structured results fill all 15 prompt slots first, so reranked chunks of other documents are dropped;
- RAG receives the un-broadened filter (tags kept) and the LLM's raw correspondent guess, so an inexact guess returns zero chunks;
- citations are validated against ~100 structured results the model never saw, and "use directly" totals cover only the 15 prompt documents;
- document text is pasted into the prompt undelimited, so an ingested e-mail can instruct the answer model.

The SPA also stays in "streaming" forever if the SSE stream ends without a `final` event.

## What Changes

- `/api/ai/answer/stream` runs RAG before the empty-result check; it answers `NO_MATCH_DE` only when both structured search and RAG come back empty.
- Prompt slots: RAG-ranked documents first, then structured results, capped at `ANSWER_CONTEXT_SIZE`.
- RAG uses the broadened filter, keeps the correspondent only when it resolves to a known correspondent (canonical name), and retries without any payload filter when the filtered search returns nothing.
- Citations resolve only against documents that were in the prompt; the back-fill uses the same set.
- Precomputed per-type totals say they are partial when the structured search matched more documents than the prompt holds.
- Each document in the answer prompt is wrapped in `<dokument id="N">…</dokument>`, and the system prompt tells the model that text inside is data, never instructions.
- SPA: when the stream ends without `final` or `error`, streaming stops and an error is shown.

## Capabilities

### New Capabilities
- `ask-retrieval`: what the streaming Ask endpoint retrieves, puts in the prompt, and accepts as citations.

### Modified Capabilities

## Impact

- `services/aktenraum-api/src/ai/{ai.controller,ai.service,answer-prompt}.ts`, tests, `test/{harness,fake-gateway}.ts`
- `apps/web/app/composables/useAnswerStream.ts`
- No API shape changes. The unused `POST /api/ai/answer` and `/api/ai/find` are left as they are.
