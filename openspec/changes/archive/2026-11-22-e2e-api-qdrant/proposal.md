# Proposal

## Why

The throwaway e2e stack runs the api with `QDRANT_URL: ""`. With Qdrant configured, the api would prewarm the ~570 MB bge-reranker (peak ~1.7 GB), which OOM-kills the 1 GB e2e container when the live stack is also up. The price is that no rehearsal can check what the **api itself** writes to Qdrant: share grants (`shared_with`), moves and member removals (`space_id`), trash flags (`trashed`), and space-scoped Ask retrieval. The share rehearsal carries a known, by-design failure for this, and the removal rehearsal only checks the worker's startup reconcile as a stand-in. These are exactly the writes that decide who can see a document in Ask. Today they're covered only by unit tests against a fake vector store. (Backlog: "Qdrant for the e2e api".)

## What Changes

- New api setting **`RERANKER_ENABLED`** (boolean, default `true`). When `false`, the api builds its RAG retrieval without a reranker: no model download, no prewarm, and retrieval keeps Qdrant's dense order (top `RAG_RERANK_TOP_K` hits). It logs `reranker_disabled` once at startup. Production behaviour is unchanged.
- The e2e compose file gives the api `QDRANT_URL=http://qdrant:6333`, `QDRANT_API_KEY=e2e-qdrant-key` and `RERANKER_ENABLED=false`.
- Rehearsals assert the api's Qdrant writes directly:
  - `share-rehearsal.mjs`: the `shared_with` checks pass instead of failing by design;
  - `removal-rehearsal.mjs`: d1's chunk `space_id` is the admin's personal space right after the removal, with no auto-tagger restart (the worker reconcile check stays as a second check);
  - `e2e-worker.sh`: moving the indexed document to the trash sets `trashed: true` on its chunks, and restoring it clears the flag.
- Docs: `docs/configuration.md` (new variable), CLAUDE.md, backlog entry removed. The superseded "live-counts streams ignore a password change" backlog entry is removed too (server-side sessions re-check every tick since `auth-server-sessions`).

## Non-goals

- Running the real reranker in e2e, or changing the reranker's memory profile.
- Putting the worker e2e into CI (it still needs a local Ollama).
- Any change to production retrieval quality or defaults.
