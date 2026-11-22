# Tasks

## 1. api

- [x] 1.1 Add `RERANKER_ENABLED` (bool, default true) to `config/settings.ts`; in `ai/retrieval.module.ts` build no `LocalReranker` and log `reranker_disabled` when false; make `RetrievalDeps.reranker` nullable; verify with a settings test (default true, `"false"` parses false).
- [x] 1.2 In `ai/retrieval.ts` share one `denseOrder` helper between the null-reranker branch and the rerank-failure fallback, and add `reranker_used` to `rag_retrieve_complete`; verify with retrieval tests (null reranker → dense top-K, no failure log; reranker throws → same order + failure log; normal → reranked order) and `pnpm --filter @aktenraum/api test` + `typecheck`.

## 2. e2e stack + rehearsals

- [x] 2.1 `docker/docker-compose.e2e.yml`: api gets `QDRANT_URL`, `QDRANT_API_KEY`, `RERANKER_ENABLED: "false"`; rewrite the comment; verify `docker compose -f docker/docker-compose.e2e.yml config` passes.
- [x] 2.2 `scripts/e2e-worker.sh`: after propagation + indexing, trash the document through the api session, assert `trashed: true` on its chunks, restore it, assert `trashed: false`; verify in the e2e run.
- [x] 2.3 `share-rehearsal.mjs`: drop the "fails by design" note; `removal-rehearsal.mjs`: assert d1's chunk `space_id` right after the removal (before the worker restart); verify by running both on the e2e stack and recording the counts.

## 3. Docs + checks

- [x] 3.1 `docs/configuration.md` (variable, "test/low-memory switch"), CLAUDE.md (configuration + e2e notes, test counts), `docs/plans/backlog.md` (remove this entry and the superseded live-counts entry); then `pnpm -r lint`, `pnpm -r build`, api + web typecheck, `pnpm -r test`; verify all green.
