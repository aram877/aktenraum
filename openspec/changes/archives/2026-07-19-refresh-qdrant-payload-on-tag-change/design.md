## Context

Today the Qdrant chunk payload (`doc_type`, `correspondent`, `tags`, `created_date`) is written exactly once per document, by `auto_tagger.indexer.index_document`, enqueued by the propagator immediately after a document reaches `ai-propagated`. That function does a full delete-by-doc-id + re-chunk + re-embed + upsert. Nothing re-runs it afterward.

Investigating "does adding a tag reach the vector index" surfaced that **editing the "Vorgeschlagene Tags" (`ai_suggested_tags`) field on an already-propagated document does not change native Paperless tags at all** — `PATCH /api/documents/{id}/fields` only ever writes the `ai_*` custom field, never the native `tags` array. That's a deliberate existing tradeoff (documented in CLAUDE.md: post-propagation field edits require "Erneut verarbeiten" to reach native fields) and is explicitly **out of scope** for this change — reopening "should ai-field edits write natively" is a bigger design question than a Qdrant-freshness fix.

There is, however, an existing code path that *does* change a document's native tags after propagation without going through the full reprocess pipeline: the star/unstar toggle (`POST`/`DELETE /api/documents/{id}/star` in `documents/router.py`), which PATCHes the native `tags` array directly to add/remove the `wichtig` tag. That toggle is the concrete, already-shipped case this change closes the gap for — starring/unstarring an already-indexed document currently leaves Qdrant's `tags` payload silently stale, so an Ask-AI query that filters by `wichtig` will miss (or wrongly include) documents based on when they happened to be indexed relative to when they were starred.

`aktenraum-api` already holds a live `QdrantVectorStore` instance on `app.state.rag_vector_store` (used today for RAG retrieval — see `ai/deps.py: get_vector_store_optional`), so it has a client in-process; the question is where the *metadata-resolution logic* (which native tags count as "user tags" vs. lifecycle/auxiliary noise, correspondent/doc_type fallback to AI fields) should live, since that logic currently exists only inside `auto_tagger.indexer._resolve_payload_metadata` against `PaperlessClient` (auto-tagger's Paperless wrapper), not `PaperlessGateway` (aktenraum-api's wrapper).

## Goals / Non-Goals

**Goals:**
- Whenever a document's native tags change through a code path that already exists today (currently: star/unstar) *after* the document has already been indexed, refresh the Qdrant payload's `tags` field so retrieval filtering reflects reality.
- Do this without re-chunking or re-embedding — the underlying paragraph text hasn't changed, only metadata has, so this should be a cheap payload-only write.
- Keep the ownership boundary from ADR-004 intact: auto-tagger remains the only thing that reads/writes Qdrant and resolves "what counts as a payload tag."

**Non-Goals:**
- Making `ai_suggested_tags` edits on an already-propagated document write native tags. That's a separate, larger decision (would need to decide whether it also re-runs duplicate detection, whether it needs its own lifecycle signal, etc.) and stays exactly as it works today: use "Erneut verarbeiten" if you want an edited AI field to become a real Paperless field.
- Any change to the RAG retrieval algorithm, the embedding pipeline, the reranker, or the answer prompt.
- Observing tag changes made directly in Paperless's own admin UI (outside aktenraum-api entirely). Nothing in aktenraum's control plane sees those today, and this change doesn't add that observability.

## Decisions

**1. New Qdrant client method: `update_metadata_by_doc_id`, not a new delete+upsert.**
Add a method to `QdrantVectorStore` (`aktenraum_core/rag/vector_store.py`) that calls Qdrant's `set_payload` (which merges into existing point payloads, unlike `upsert` which replaces the whole point) filtered by the same `FieldCondition(key="doc_id", ...)` selector `delete_by_doc_id` already uses. It takes the same four metadata fields `upsert_chunks` does (`doc_type`, `correspondent`, `tags`, `created_date`) and touches only those keys — `text`, `char_start`, `char_end`, `token_count`, `chunk_index` are left untouched.
*Alternative considered*: reuse `delete_by_doc_id` + full `index_document` re-run. Rejected — that re-embeds every chunk for a metadata-only change, which is wasted Ollama round-trips proportional to document length, for a fix whose entire point is "this should be cheap."

**2. Metadata resolution stays inside auto-tagger; aktenraum-api pings it, mirroring the existing `/trigger/propagate` pattern.**
Add `refresh_index_metadata(doc_id, deps)` to `auto_tagger/indexer.py` — thin wrapper that calls the existing `_resolve_payload_metadata` (already used by `index_document`) and then `vector_store.update_metadata_by_doc_id(...)`. Expose it over auto-tagger's internal HTTP listener as `POST /trigger/reindex-metadata` (secret-gated via the existing `X-Aktenraum-Secret` mechanism, same as `/trigger/extract` and `/trigger/propagate`). The star/unstar handler in `documents/router.py` fires a best-effort, bounded-timeout POST to this endpoint after a successful native-tags PATCH, exactly the way `POST /api/inbox/{id}/approve` already pings `/trigger/propagate` today.
*Alternative considered*: have aktenraum-api call `vector_store.update_metadata_by_doc_id` directly (it already holds a client) and duplicate a slimmed-down metadata resolver against `PaperlessGateway`. Rejected — would duplicate the "what counts as a payload tag" logic across two services with two different Paperless client classes, which is exactly the kind of drift ADR-004 already flagged as the cost of the two-service split (fields that must stay in sync). Keeping one function as the single source of truth for payload-tag resolution is worth one extra fire-and-forget HTTP hop.

**3. Guard: skip the refresh (not error) if the document isn't indexed yet.**
`update_metadata_by_doc_id` on a doc with zero Qdrant points is a harmless no-op (Qdrant's `set_payload` over an empty filter match just touches nothing). No need for the caller to check `ai-propagated` state first — that would require an extra Paperless round-trip just to decide whether to make the call. Since the whole path is best-effort and non-fatal, letting Qdrant itself no-op is simpler and correct.

## Risks / Trade-offs

- **[Risk]** New internal endpoint (`/trigger/reindex-metadata`) is one more thing for `WEBHOOK_SECRET` consistency to depend on, and one more best-effort call that can silently fail. → **Mitigation**: identical bounded-timeout, swallow-and-log pattern as the existing `/trigger/propagate` call; failure never blocks the star/unstar response to the user, and it's inherently self-healing — the next full reprocess (or any future re-indexing pass) will pick up the correct tags regardless.
- **[Risk]** Scope is narrower than "any tag change stays fresh" — it only covers the star/unstar path today, not `ai_suggested_tags` edits (which don't touch native tags at all, see Non-Goals). A user reading only the proposal title might expect the broader fix. → **Mitigation**: proposal and design both spell out the narrower scope explicitly; the `ai_suggested_tags`-on-already-propagated-doc gap remains a known, separately-trackable follow-up if it turns out to matter in practice.
- **[Trade-off]** `set_payload` merges rather than replaces — if a future field is added to `ChunkPayload` and someone forgets to include it in `update_metadata_by_doc_id`, that field would silently never get refreshed by this path (only by a full re-index). → **Mitigation**: keep the field list in `update_metadata_by_doc_id` and `upsert_chunks` next to each other in the same file with a comment cross-referencing the other, so a future field addition is easy to catch in review.

## Migration Plan

Purely additive — no schema migration, no data backfill required (existing indexed docs keep whatever tags they had at their last index/refresh; the new path only affects tags that change *after* this ships). Deploy order: `task tagger:rebuild` (ships the new vector-store method + internal endpoint) before or together with `task api:rebuild` (ships the star/unstar trigger call) — if the api ships first and pings a not-yet-updated auto-tagger, the call 404s and is swallowed exactly like any other best-effort trigger failure, so ordering isn't strictly required but rebuilding both together avoids the brief inconsistency window.

## Open Questions

- Should the same trigger also fire from `dismiss-duplicate`? Today `ai-duplicate-dismissed` is filtered out of the Qdrant payload by `_filter_user_tags` (it's an auxiliary/lifecycle-adjacent marker, not a user tag), so it doesn't need this — noted here so it isn't reconsidered by mistake later.
- If a future change adds a general "edit native tags" UI to the Library review page, that new endpoint should call the same `/trigger/reindex-metadata` path rather than reinventing it.
