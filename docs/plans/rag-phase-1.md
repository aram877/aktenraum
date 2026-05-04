# RAG Phase 1 — Production-grade local retrieval

The durable plan for replacing the answer pipeline's shallow candidate-fetch (`_enrich_with_ai_fields` over Paperless metadata) with a full retrieval stack: dense embeddings + lexical/BM25 + cross-encoder reranking, all running locally. This is the differentiator for the sellable product per ADR-002 (privacy-first, local-LLM-only).

**Status**: Not started. This document is the spec.

---

## Goal

When a user asks "wie lange habe ich bei Kopfstand gearbeitet" — a question whose answer lives in the *body* of the CV, not in any structured metadata field — the system returns the right answer with the right citation. Today this fails because the answer LLM only sees `ai_summary_de`, dates, and amounts; it never sees the OCR'd text. Phase 1 fixes that by indexing every document's content into a vector store and retrieving the most relevant *chunks* at query time.

## Non-goals

- **Replacing the structured-field path.** Many questions ("wann läuft mein Pass ab", "was hat XYZ gekostet") are answered cheaply from `ai_expiry_date` / `ai_monetary_amount`. Phase 1 retains those as a fast path; RAG is the fallback when structural fields can't answer.
- **Multi-language tuning beyond German + English.** The target buyer is German-speaking; our embedding and reranker model choices must work well on German, but we do not optimize for Japanese / CJK / RTL languages in v1.
- **Real-time indexing latency under 1s.** A 30s end-to-end indexing latency (doc propagated → searchable) is acceptable given personal-DMS scale.
- **Fine-tuning models.** We use off-the-shelf weights only. Fine-tuning is a possible Phase 2 lever but irrelevant until we have eval signal.

## Constraints

- **Local-only.** No data leaves the host. No cloud embedding API. The only allowed network egress is one-time model pulls (already constrained by Ollama).
- **Single-host Docker Compose.** Same deployment shape as today. Adding services is fine; adding a Kubernetes cluster is not.
- **Per-doc index footprint capped.** ~3 KB / chunk × ~100 chunks/doc = ~300 KB / doc. At 10,000 docs this is 3 GB — comfortable. We monitor index size; if a single doc exceeds 1 MB indexed footprint we log it.
- **Eval-driven.** Every Phase 1 sub-deliverable lands with measurable retrieval quality (recall@5, MRR) on a fixed eval set. No "we shipped it and it feels better" merges.

## Architecture decisions (binding)

### Vector store: Qdrant (new container)

Considered: pgvector (cheaper — postgres already there), Qdrant (dedicated), Vespa (most powerful but operationally heavy).

**Decision: Qdrant.** pgvector at small scale is fine, but a sellable product is sized for the scale we *will* hit, not the scale we have. Qdrant gives us:
- Native hybrid search (dense + sparse + filters in a single query).
- Payload filtering (so structural filters — doc_type, tags, date — apply at the vector layer).
- Snapshot/restore for backup integration.
- HTTP and gRPC; we use HTTP from Python.
- One container, ~30 MB image, persistent volume.

The cost is one more service to monitor and back up. The win is no rewrite when corpus grows past pgvector's comfort zone (~100k chunks).

### Embedding model: `bge-m3` via Ollama

Considered: `nomic-embed-text-v1.5` (lighter, multilingual), `multilingual-e5-large-instruct` (strong on German), `bge-m3` (BAAI, hybrid dense+sparse+ColBERT in one model).

**Decision: `bge-m3`.** It's the only widely-deployed open model that emits dense + sparse vectors *from the same model*, so we get hybrid retrieval (lexical + semantic) without running two separate inference paths. 1024-dim dense vectors. Multilingual with strong German performance. Available in Ollama. ~2 GB on disk.

### Reranker: `bge-reranker-v2-m3`

A cross-encoder reranker is the single largest quality improvement after basic retrieval. Without it, top-K cosine returns plausibly-relevant-but-often-wrong chunks; with it, the top-3 are nearly always the right ones. ~600 MB, multilingual, runs on CPU acceptably (~50ms per (query, chunk) pair).

Until Ollama supports loading reranker models natively, we run a small Python wrapper using `sentence-transformers` directly (already a transitive dep via `transformers`). If/when Ollama adds reranker support, swap to it without API changes.

### Chunking: paragraph-aware, ~500 tokens, ~50-token overlap

Considered: fixed-size token windows (simple, dumb), recursive character splitting (LangChain default), semantic chunking (split where embedding similarity drops), late chunking (embed full doc → split embeddings).

**Decision: paragraph-aware token splitting with overlap.** Specifically:
1. Split source text on double-newline (paragraph boundaries) — preserves semantic units that German document OCR usually respects.
2. Pack paragraphs greedily into chunks until reaching ~500 tokens (using a tokenizer that matches `bge-m3` — bert-style).
3. If a single paragraph exceeds 500 tokens (rare; long contract clauses), fall back to sentence-level splitting via German-aware sentence tokenization.
4. Add 50-token overlap between chunks to preserve cross-boundary context.
5. Each chunk records `(doc_id, chunk_index, text, char_start, char_end, page_number?)`. Page numbers come from Paperless's per-page content if available, else `null`.

Rationale: paragraph-aware is "good enough" for personal-DMS docs (invoices, contracts, CVs) without the complexity of layout-aware extraction (which is Phase 2 territory via Docling). Token budget of 500 fits well within `bge-m3`'s 8192-token context with headroom for the next-step reranker prompt.

### Hybrid retrieval at query time

For every question we run **three** retrieval signals and combine them:

1. **Dense vector search** in Qdrant — top-50 by cosine over `bge-m3` dense vectors.
2. **Sparse vector search** in Qdrant — top-50 by `bge-m3`'s sparse output (acts like learned BM25 — catches exact-string queries like invoice numbers).
3. **Structural filter** — payload `WHERE` clauses (doc_type, correspondent, tags, dates) applied at the Qdrant layer, narrowing both 1 and 2.

Combine 1+2 via Reciprocal Rank Fusion (RRF, k=60), dedupe by `(doc_id, chunk_index)`, take top-50, send to reranker, reranker → top-5, top-5 → answer LLM.

This is a textbook hybrid pipeline. The win over pure dense is on out-of-vocabulary queries (German company names, invoice numbers); the win over pure sparse is on paraphrase / synonym queries.

### Indexing pipeline: triggered post-propagation, in the auto-tagger

Auto-tagger already has the lifecycle of every doc through asyncio. Adding an indexing step is a fifth concurrent task in `main.py` alongside extraction-worker, poller, propagation, and HTTP server.

Trigger: a doc reaches `ai-propagated`. The propagator emits to a new `asyncio.Queue[int]` (`indexing_queue`). The indexer worker:

1. Fetches the doc from Paperless including `content` (the OCR'd text).
2. Chunks via the chunker module.
3. Calls `bge-m3` once per chunk batch (Ollama supports batched embedding) — both dense and sparse outputs.
4. Upserts into Qdrant with payload `{doc_id, chunk_index, text, page, doc_type, correspondent, tags, created_date}` so structural filters work at retrieval time.
5. On reprocess (lifecycle reset → re-propagation), the existing chunks are deleted before reindexing (idempotent).

Failure modes are logged to `ai-index-error` (a new tag) so the user can see what's not searchable. The auto-tagger keeps doing its other jobs even if Qdrant is down.

### Backfill: one-shot script, idempotent

`scripts/backfill-rag-index.sh` iterates every `ai-propagated` doc, calls the same indexer code path, skips docs already present in Qdrant. Resumable. Logs progress as JSON lines so the desktop shell (when it exists) can render a progress bar.

### Eval harness

A YAML file `evals/golden-questions.yaml`:

```yaml
- question: "Wie lange habe ich bei Kopfstand gearbeitet?"
  expected_doc_ids: [16]
  expected_in_top_k: 5
  language: de
  category: cv-employment
- question: "Was hat die Stromrechnung im März 2024 gekostet?"
  expected_doc_ids: [42, 43]
  expected_in_top_k: 3
  category: invoice-amount
```

A `services/aktenraum-api/scripts/run-eval.py` runs every question through `_execute_filter` + the new RAG retrieval, computes per-question hits and aggregate recall@K and MRR, and emits a YAML report. CI runs this on every PR; a regression below threshold blocks merge.

This is the single most important piece of infra for credibility. Without it, "best-in-class retrieval" is unsubstantiated marketing.

## Schema

### Qdrant collection: `aktenraum_chunks`

```yaml
vectors:
  dense:
    size: 1024
    distance: Cosine
sparse_vectors:
  sparse:
    {}  # bge-m3 emits SPLADE-like sparse vectors
payload_schema:
  doc_id:           keyword (indexed)
  chunk_index:      integer
  text:             text (not indexed for search; just retrieval)
  page:             integer (nullable)
  doc_type:         keyword (indexed) — Paperless document_type name
  correspondent:    keyword (indexed)
  tags:             keyword[] (indexed)
  created_date:     datetime (indexed)
  ai_propagated_at: datetime (indexed) — for incremental backfill cursors
```

### Postgres: no schema changes in Phase 1

We don't need a chunks table in postgres — Qdrant is the source of truth for chunks. The `aktenraum` postgres database keeps users, sessions, and any future saved-search state.

If Phase 2 layout-aware chunking needs to track per-doc indexing metadata (e.g., chunker version), we add a `document_index_metadata` table then.

## API contracts

### New: `GET /api/admin/index/status`

Returns indexing health for the desktop shell:
```json
{
  "qdrant_reachable": true,
  "collection_exists": true,
  "indexed_doc_count": 1234,
  "pending_index_queue_size": 5,
  "last_indexed_at": "2026-05-04T18:23:11Z"
}
```

### Modified: `POST /api/ai/answer/stream`

The pipeline changes:
- Old: filter LLM → Paperless retrieval → top-N docs → metadata into prompt → stream answer.
- New: filter LLM → hybrid Qdrant retrieval (with payload filter from the SearchFilter) → top-50 → reranker → top-5 chunks → chunks (not full docs) into prompt → stream answer.

The SSE event sequence is unchanged (`meta` → `chunk` → `final`). The `meta` event payload extends with `retrieval_strategy: "rag" | "structural"` so the SPA can render a "found by full-text search" subtle indicator.

### Modified: `POST /api/ai/find`

Same upgrade path. Find returns documents (not chunks), but underneath uses the same hybrid pipeline. We aggregate chunk hits up to docs and return ordered docs.

## Sub-phasing within RAG Phase 1

Each becomes its own commit (per the user's preference for clean small commits).

- **1.1 — Chunker module.** `aktenraum-core/src/aktenraum_core/rag/chunker.py`. Paragraph-aware splitter. Pure function, fully testable without dependencies.
- **1.2 — Embedder module.** `aktenraum_core.rag.embedder.OllamaEmbedder` calling Ollama's `/api/embed` (and `/api/embed` for sparse — bge-m3 specifics). Tested with a stub HTTP server.
- **1.3 — Qdrant client wrapper.** `aktenraum_core.rag.vector_store.QdrantStore`. Thin wrapper: ensure-collection, upsert, search, delete-by-doc-id. Tested with `respx`.
- **1.4 — Qdrant container in compose.** `docker/docker-compose.yml` adds a `qdrant` service with persistent volume under `${AKTENRAUM_DATA_DIR}/qdrant` (forward-compatible with Phase 0.2). Healthcheck.
- **1.5 — Indexer task in auto-tagger.** Fifth concurrent task. Triggered on propagation. Includes `ai-index-error` lifecycle tag for failures.
- **1.6 — Backfill script.** `scripts/backfill-rag-index.sh` — one-shot, idempotent, resumable.
- **1.7 — Reranker module.** `aktenraum_core.rag.reranker` using `sentence-transformers` directly. Loads `bge-reranker-v2-m3` once at process start; reranks (query, chunks) → ordered.
- **1.8 — Hybrid retrieval at query time.** New `aktenraum_api.rag.retrieve` that runs dense+sparse+payload filter via Qdrant, RRF-fuses, reranks. Replaces the current `_enrich_with_ai_fields` step in `/answer/stream`.
- **1.9 — Modify `/answer/stream` prompt.** Use chunks (not full-doc summaries) as context. Citations now reference `(doc_id, page?)` so the SPA can deep-link to a page.
- **1.10 — Eval harness.** YAML + runner + CI integration. `make eval` target.
- **1.11 — Model auto-pull integration.** Reuse Phase 0.3 (when it lands) — bge-m3 and bge-reranker-v2-m3 added to the pull list. Until then, manual `ollama pull` documented in CLAUDE.md.
- **1.12 — Documentation pass.** CLAUDE.md updated with the RAG architecture; runbook for "what to do when Qdrant goes down."

Estimated effort: 1.1–1.4 are 1 day combined (foundations, all pure-ish). 1.5–1.6 are another day (asyncio integration). 1.7–1.9 are 2 days (the retrieval rewrite + reranker tuning). 1.10 is 1 day (the most underrated investment). 1.11–1.12 land alongside other phases. Total: ~5 working days for a complete, evaluable RAG pipeline.

## Risks and open questions

- **bge-m3 sparse output via Ollama.** Ollama's embed endpoint may not yet expose sparse vectors. If not, we initially run dense-only and add sparse via a small bge-m3 sidecar (Python service running `transformers` directly). Confirm in 1.2.
- **Reranker latency on CPU.** ~50 ms per pair × 50 candidates = ~2.5 s. Acceptable for a question-answering UX where the LLM step is 5+ s anyway. If unacceptable, we cap candidates to 20 or use a smaller reranker (`bge-reranker-base`).
- **Memory pressure.** bge-m3 + reranker + Qwen 14B + Ollama overhead = significant RAM. State the recommended 32 GB requirement clearly in onboarding (per ADR-002 hardware preflight).
- **Qdrant snapshot integration with restic.** Verify in 1.4 that Qdrant's persistent volume backs up cleanly via the existing restic flow. Worst case: add a `qdrant snapshot create` call to the backup cron.
- **Eval set bootstrapping.** We don't have a golden set yet. The first 20 questions are seeded by the developer based on their own corpus; we expand it as users send issues.

## Related

- Builds on `docs/plans/desktop-app.md` Phase 0.2 (`AKTENRAUM_DATA_DIR`) — the Qdrant volume must use it. We can ship Qdrant before 0.2 lands by hardcoding `${HOME}/aktenraum/qdrant` and migrating later.
- Builds on existing `/api/ai/answer/stream` (commit `c899b76`) — the SSE shell stays, only the retrieval step swaps.
- Replaces the rumored Phase 6 in `docs/plans/custom-frontend.md` ("Semantic search / RAG"). Update that doc once 1.8 ships.
