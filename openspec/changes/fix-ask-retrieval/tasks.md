## 1. API

- [x] 1.1 `AiService.vectorFilterFor` (broadened, canonical correspondent) + unfiltered retry in `retrieveChunks`
- [x] 1.2 `promotePromptResults`: RAG docs first, then structured, capped
- [x] 1.3 Stream: RAG before the empty check; citation pool = prompt docs
- [x] 1.4 `answer-prompt.ts`: partial-total labelling, `<dokument>` delimiters + system rule
- [x] 1.5 Harness hooks for LLM + retrieval; route tests for the stream; unit tests

## 2. SPA

- [x] 2.1 `useAnswerStream`: end-of-stream without `final` → error, streaming off; test

## 3. Verify and document

- [x] 3.1 `pnpm -r lint`, `pnpm -r build`, `pnpm -r test`, api typecheck, web typecheck
- [x] 3.2 Rebuild api + nginx, ask a body-only question live
- [x] 3.3 CLAUDE.md
- [x] 3.4 Session note at commit time

## 4. Found during live verification

- [x] 4.1 `LocalReranker` batches (8) and caps tokens (512) — unbatched rerank OOM-killed the api (exit 137)
- [x] 4.2 RAG-only prompt docs resolve correspondent + document type names
