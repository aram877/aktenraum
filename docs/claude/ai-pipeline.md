# AI: Ask, RAG indexing, backfill, eval

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

### AI: Find docs (`/api/ai/find`)

> **Note (2026-06-01)**: the SPA `/find` page + `FilterChips` component + the `useFind` client hook were removed; AI search folded into Ask AI. The backend endpoint below still exists and is tested but is no longer called by the frontend.

- `POST /api/ai/find` is the structured-search endpoint. Auth-gated. Accepts either `{"query": str}` (LLM path) or `{"filter": SearchFilter}` (no LLM, used for chip-edit re-runs). Returns `{filter, results, explanation, total}`.
- `SearchFilter` is closed-enum: `document_type` reuses `DocumentType` from `@aktenraum/core`, plus `correspondent`, `date_from`, `date_to`, `text`, `tags`. Unknown doc types → 422. Cross-type amount filtering was removed when the generic `monetary_amount` field was retired — money lives on type-specific schemas only (Rechnung.gesamtbetrag, Mahnung.forderungsbetrag, etc.).
- Server-side `PaperlessGateway` (`src/paperless/paperless.gateway.ts`) holds the API token; per-process correspondent / tag / custom-field-id caches; the token never reaches the SPA.
- Translator (`src/ai/translate.ts`) → Paperless query params using `document_type__id` / `correspondent__id` (the bare names are silently ignored — same gotcha class as `?name=` on `/api/tags/`).
- Prompt (`src/ai/prompt.ts`) inlines the doc-type taxonomy, the live correspondent list (cap 200), date rules, and a few German few-shot exemplars. An explicit note tells the LLM there are no amount fields on the filter. **Modular extras**: `ai/intent.ts` `detectIntents(query)` runs a German keyword classifier (`SALARY` / `SPENDING` / `TAX` / `INSURANCE` / `HOUSING` / `MEDICAL` / `ID_DOCUMENT` / `CAR` / `CONTRACT`); whenever an intent fires, the matched `ai/prompt-modules.ts` `MODULES[docType].filterExamples` are appended to the few-shot block so the LLM sees a typed mapping for the shape at hand. Neutral queries fall through to the static set unchanged (prompt-cache stable). Substring match by default — short ambiguous keywords (`pass`, `lohn`) opt into strict whole-word matching via `STRICT_KEYWORDS`.

### AI: Ask pipeline (`fast-ask`, 2026-11-23)

- **No filter LLM.** `POST /api/ai/answer` and the JSON-envelope prompt are gone. `/api/ai/answer/stream` parses the question deterministically (`ai/question-parser.ts`: years, "letztes Jahr", month + year, "seit", doc types via `detectIntents` + type names, correspondents by distinctive-token match with a generic-word stop-list, cap 3), then runs three paths in parallel: **semantic** (Qdrant + rerank, never narrowed by hints), **full-text** (Paperless `query`, content words joined with OR, 10) and **structured** (`document_type__id__in` / `correspondent__id__in` / created dates, `-created`, only when a hint resolves). Prompt slots: semantic ≤ 5, then structured, then full-text, de-duplicated, ≤ `ANSWER_CONTEXT_SIZE` (15) (`mergeCandidateIds`). Candidates load with one `id__in` call + one `TypeFieldsService.getMany`.
- SSE order `meta` (total null) → `sources` → `chunk`… → `final`; the SPA shows source cards on `sources`. One `ask_timing` log line per question (parse / retrieve / enrich / first token / total, no question text); `rag_retrieve_complete` adds embed / search / rerank ms.
- The answer prompt is assembled from `ai/prompt-modules.ts` (field hints, per-type examples) with per-field caps (`PROMPT_LIMITS`); a test keeps the worst case under 11.5k tokens.
- Env: `RERANK_CANDIDATES` (20), `OLLAMA_KEEP_ALIVE` (unset = Ollama's 5 min default; `-1` pins the answer model + embedder in VRAM, ~20 GB), `OLLAMA_ANSWER_NUM_CTX` (default = `OLLAMA_NUM_CTX`; **set 12288 on a 24 GB GPU**). `EMBED_NUM_CTX` (4096, in `@aktenraum/core`) is shared by worker and api.
- `/api/ai/find` keeps its LLM filter (unused by the SPA).

### AI: Streaming answer + RAG (`/api/ai/answer/stream`)

The user-facing /ask page consumes this endpoint. Streaming plus RAG:

1. **SSE token-by-token streaming.** Replaces the silent ~30s wait with `meta` → repeated `chunk` → `final` (or `error`) events. Inline `[Quelle: <id>]` markers in the streamed prose are regex-extracted post-hoc and intersected with retrieved docs to populate citations. The streaming-specific prompt (`buildStreamingAnswerMessages`) instructs the model to use the marker format and is prose-only (NOT JSON envelope).
2. **RAG retrieval (Phase 1).** When `QDRANT_URL` is set, every question runs through `src/ai/retrieval.ts` `retrieveChunksForQuestion`: embed query (qwen3-embedding:4b) → Qdrant search top-50 with payload filter → bge-reranker-v2-m3 cross-encoder rerank → top-5 chunks. Those chunks land under "Relevante Auszüge:" inside each candidate's prompt block, alongside the existing AI metadata fields. This is what answers questions whose information is in the document body (CV employment durations, contract clauses, table values) — pre-RAG the LLM only ever saw `ai_summary_de` + dates + amounts.

**Retrieval order (2026-10-01, `fix-ask-retrieval`)**: RAG runs before the empty-result check, so a wrong structured guess (e.g. `Zeugnis` for a CV filed as `Sonstiges`) no longer short-circuits to "nicht gefunden" — the no-match answer fires only when structured search AND RAG are both empty. The Qdrant filter is derived from the broadened filter (tags dropped; correspondent kept only when it case-insensitively matches a known Paperless correspondent, since the payload stores the native name) and retries once unfiltered when the filtered search is empty (`rag_retrieve_unfiltered_fallback`). Prompt slots: RAG-ranked docs first (≤5), then structured results, capped at `ANSWER_CONTEXT_SIZE` (15). Citations resolve only against docs that were in the prompt. Each candidate is wrapped in `<dokument id="N">…</dokument>` (any `</dokument` inside the text is neutralised) and the system prompt says text inside is data, never instructions — the indirect-prompt-injection guard for e-mail-ingested documents. Precomputed per-type totals are labelled UNVOLLSTÄNDIG when the structured `total` exceeds the prompt candidates.

Resilience: any RAG stage failing degrades gracefully (embedder error → empty result, qdrant error → skip rerank, reranker error → fall through to dense-only ordering). Empty / `QDRANT_URL`-unset → falls back to the AI-metadata-only path so the endpoint keeps working.

`RERANKER_ENABLED=false` (test / low-memory switch, set only by the throwaway e2e stack so its 1 GB api can still write to Qdrant) skips the reranker entirely — no download, no prewarm, retrieval keeps Qdrant's dense order (`reranker_disabled` at startup, `reranker_used: false` in `rag_retrieve_complete`). Otherwise the bge-reranker-v2-m3 model is **pre-warmed at startup** as a background task (`src/ai/retrieval.module.ts`) so the first `/ask` after a fresh container is not blocked by the ~570 MB HF download (the quantized ONNX export). The download lands in the `aktenraum-node-hf-cache` named volume (mounted at `/home/appuser/.cache/huggingface`, pinned via `HF_HOME` / `HUGGINGFACE_HUB_CACHE`), so it survives `docker compose up -d --build aktenraum-api`. End-to-end warm took ~80s on the dev host on first run; subsequent rebuilds are instant because the cache persists. Steady-state rerank is ~50 ms × 50 candidates ≈ 2.5s. If a request lands while the warm-up is still running the reranker's in-flight promise makes it wait on the existing load instead of starting a second one. **Volume permissions gotcha**: a fresh named volume mounts as root-owned; the Dockerfile pre-creates `/home/appuser/.cache/huggingface` with `appuser` ownership so Docker copies the right mode into the volume on first attach. If you ever see `reranker_prewarm_failed` with a `PermissionError`, the volume was created before the Dockerfile fix — `docker volume rm docker_aktenraum-node-hf-cache` and rebuild.

**Denial suppresses citations.** When the answer LLM writes the prompt-baked "I couldn't find that" template (`DENIAL_RE` in `ai.service.ts` — matches "in den Dokumenten nicht finden", "keine passenden Dokumente", "keines der Dokumente enthält", and three more variants, length-capped at 200 chars), the no-citations back-fill is skipped and the SPA renders the denial alone. Without this gate the back-fill rule ("if the model wrote prose but cited nothing, surface the retrieved set so the user has a source to verify against") rendered source cards beneath a "nicht gefunden" message, which looked like the AI was lying about its own search. The gate is strict — partial answers longer than 200 chars that happen to contain a denial phrase still get their citations back-filled.

### RAG: indexing pipeline (auto-tagger)

Indexing fans out from propagation. When a doc reaches `ai-propagated`, the propagator enqueues its id on the `indexing_queue`; a fifth concurrent task in the auto-tagger drains the queue and runs:

```
fetch document by id from Paperless
  ↓
chunk content (paragraph-aware, ~500 tokens, ~50-token overlap)
  ↓
batch-embed via Ollama (single round-trip per doc)
  ↓
delete-by-doc-id from Qdrant (idempotent: re-index never duplicates)
  ↓
upsert with denormalised payload (doc_type, correspondent, tags, created_date)
```

**Tenancy**: every chunk payload carries `space_id` (home space; null/missing = unassigned) and `shared_with` (member ids, empty until sharing), both integer-indexed (`ensureCollection` adds missing indexes). The worker reads the space from `GET /api/tenancy/documents/:doc_id/space` (worker scope `internal:tenancy-read`); a failing lookup fails the index (`ai-index-error`, old chunks kept) rather than indexing unscoped. Member retrieval ANDs `space_id ∈ my spaces OR shared_with ∋ me` (+ `space_id` empty for the household admin) onto every search, including the unfiltered retry — verified on Qdrant 1.17.1. Few-shot examples, the correspondent history hint and duplicate detection (worker and `duplicate-candidates`) only use documents of the same home space; with the space unknown they're skipped. Failures tag `ai-index-error` (auxiliary, NOT in `LIFECYCLE_TAGS`); success self-heals — clears the error tag if previously set. Cap of 200 chunks per doc protects against runaway OCR.

**Opt-in via `QDRANT_URL`**: empty (or unset) disables the indexer worker and the propagator hook, so the existing extraction + propagation paths keep working when RAG is intentionally off.

### RAG: backfill the existing corpus

Newly-propagated docs index automatically; the existing corpus needs a one-shot. From repo root:

```bash
bash scripts/backfill-rag-index.sh           # idempotent, skip already-indexed
bash scripts/backfill-rag-index.sh --force   # re-index everything
```

JSON-line events on stdout: `started → doc_skipped|doc_indexed|doc_failed* → completed`. Resumable: re-running on a fully-indexed corpus is a fast no-op (one cheap Qdrant `count` per doc, then skip).

### RAG: eval harness

Measures retrieval quality so prompt / model / chunker changes are evaluable rather than vibes-only.

```bash
bash scripts/run-rag-eval.sh                 # text report
bash scripts/run-rag-eval.sh --json          # CI-friendly JSON
```

Cases live in `evals/golden-questions.yaml` (bind-mounted into the api container at `/app/evals/`). Each case: `id`, `question`, `expected_doc_ids`, optional `expected_in_top_k` (default 5). Multi-doc-expected supported (a question that could legitimately be answered by either of two filings).

Output: per-case rank + hit/miss + aggregate `recall@K` and `MRR` (mean reciprocal rank). Exit code is 0 regardless of metrics — the wrapper / CI decides the threshold.

The committed YAML is keyed to the dev maintainer's local Paperless ids; buyers / new collaborators copy to a private location and re-pin against their own corpus.

