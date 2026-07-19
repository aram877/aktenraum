## 1. Vector store: metadata-only update

- [x] 1.1 Add `update_metadata_by_doc_id(doc_id, *, doc_type, correspondent, tags, created_date)` to `QdrantVectorStore` in `packages/aktenraum-core/src/aktenraum_core/rag/vector_store.py`, using `set_payload` with the same `FieldCondition(key="doc_id", ...)` filter selector `delete_by_doc_id` uses. Update only the four metadata keys; leave `text`, `chunk_index`, `char_start`, `char_end`, `token_count` untouched.
- [x] 1.2 Unit test: seed a fake/mocked point, call the new method, assert only the metadata keys changed and the point count / vector are untouched.
- [x] 1.3 Unit test: calling the method for a `doc_id` with zero existing points completes without raising.

## 2. auto-tagger: refresh coroutine + internal trigger endpoint

- [x] 2.1 Add `refresh_index_metadata(doc_id, deps)` to `services/auto-tagger/src/auto_tagger/indexer.py`, reusing the existing `_resolve_payload_metadata` helper, then calling `vector_store.update_metadata_by_doc_id(...)`. No chunking, no embedding calls.
- [x] 2.2 Expose `POST /trigger/reindex-metadata` on the auto-tagger's internal HTTP listener (`webhook.py` / wherever `/trigger/extract` and `/trigger/propagate` are registered), accepting `{"document_id": int}`, gated by the same `X-Aktenraum-Secret` check as the existing trigger endpoints.
- [x] 2.3 Test: valid secret + document_id → calls `refresh_index_metadata` with the right doc id.
- [x] 2.4 Test: missing/invalid secret (when `WEBHOOK_SECRET` is set) → request rejected, refresh not attempted.

## 3. aktenraum-api: fire the trigger from star/unstar

- [x] 3.1 In `documents/router.py`, after `star_document` successfully PATCHes native tags, fire a best-effort, bounded-timeout `POST {AUTO_TAGGER_URL}/trigger/reindex-metadata` with the doc id (mirror the existing pattern used by `POST /api/inbox/{id}/approve` calling `/trigger/propagate` — swallow errors/timeouts, log a warning, never fail the parent request).
- [x] 3.2 Do the same in `unstar_document`.
- [x] 3.3 Test: star/unstar endpoint still returns 200 and succeeds even when the trigger call raises, times out, or the auto-tagger is unreachable (mock the HTTP client to fail).
- [x] 3.4 Test: star/unstar endpoint issues the trigger call with the correct doc id and secret header when the auto-tagger dependency is healthy.

## 4. Docs

- [x] 4.1 Add a row to `CLAUDE.md`'s "Known gotchas" or the RAG section noting that Qdrant tag metadata now refreshes on star/unstar, but still does NOT refresh from `ai_suggested_tags` edits on an already-propagated doc (that still requires "Erneut verarbeiten") — so the scope boundary isn't rediscovered by a future session.
- [x] 4.2 Session note at `docs/sessions/YYYY-MM-DD.md` per the binding documentation cadence once this ships.
