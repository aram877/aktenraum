# Backlog

Small, self-contained follow-ups that aren't worth an OpenSpec change yet.
Each entry: what's wrong, where, and a sketch of the fix. Take one, and if it
grows beyond a day's work, turn it into a change with `/opsx:propose`.

## Qdrant for the e2e api

- **Problem**: `docker/docker-compose.e2e.yml` runs the api with
  `QDRANT_URL: ""` (so it doesn't prewarm the ~570 MB reranker), which means
  rehearsals can't check Qdrant payload writes made by the api itself — shares
  (`shared_with`), moves and member removals (`space_id`). The share rehearsal
  had one expected miss for this; the removal rehearsal checked the worker's
  chunk-space reconcile instead.
- **Fix**: set `QDRANT_URL` / `QDRANT_API_KEY` for the e2e api and add a
  switch to skip the reranker prewarm (e.g. `RERANK_PREWARM=false`, read in
  `src/ai/retrieval.module.ts`); then assert payloads directly in
  `scripts/spikes/share-rehearsal.mjs` and `removal-rehearsal.mjs`.

## Open live-counts streams ignore a password change

- **Problem**: `GET /api/events/counts` authorises once at connect. Since
  2026-11-20 it ends when the member is removed, but a password change (which
  invalidates every other session) doesn't end an already-open stream on
  another device — it keeps sending counts until that tab reconnects.
- **Fix**: superseded by ADR-010 step 4 (server-side sessions): the stream
  checks "session still active" per tick. If step 4 slips, a stop-gap is to
  re-verify the JWT fingerprint against `users.password_hash` per tick.
