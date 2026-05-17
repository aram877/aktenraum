## Context

Paperless-ngx 2.x has a built-in trash mechanism behind `/api/trash/`. Documents land there on `DELETE /api/documents/{id}/`; the trash auto-empties after `PAPERLESS_EMPTY_TRASH_DELAY` days (default 30). Both gateway and SPA today treat delete as if it were hard-delete, which is the bug this change fixes.

Two integration points need to behave coherently:
- **Paperless trash** owns the source-of-truth list (PDF, OCR, custom fields, lifecycle tags, the lot).
- **Qdrant** holds per-chunk vector embeddings keyed by `doc_id` in the payload filter. Soft-delete doesn't touch them; hard-delete must.

The SPA needs one new page (`/trash`) plus a count badge in the nav. The cache-invalidation story matters because the same doc shows up in three places at once: in `/library` (until soft-deleted), in `/trash` (until hard-deleted or restored), and in `useInFlight` (until any lifecycle tag is set; trashed docs may still carry the lifecycle tag they had).

## Goals / Non-Goals

**Goals:**
- The SPA's "Löschen" verb means the same thing the user thinks it means: doc → trash, reversible for ~30 days, then auto-gone.
- A `/trash` page that lets the user (a) see what's in the trash, (b) restore one, (c) Endgültig löschen one (hard-delete + Qdrant purge), (d) empty the whole trash in one action.
- Hard-delete is *actually* hard: Paperless `empty` + Qdrant chunk purge for the same id, in that order, with the Qdrant purge being best-effort and not gating Paperless's hard-delete.
- The change works whether `QDRANT_URL` is set or empty (RAG-disabled installs see Qdrant calls no-op silently).

**Non-Goals:**
- Filtering RAG retrieval to exclude chunks of trashed docs at query time. Documented limitation; orthogonal change.
- Backfilling Qdrant for docs that were soft-deleted before this change shipped (those chunks orphan when Paperless auto-empties at 30 days; cleanup script is a follow-up).
- Bulk multi-select / shift-click semantics in the trash list. Single-row actions + empty-all is enough at personal-DMS scale.
- Changing `PAPERLESS_EMPTY_TRASH_DELAY` from its default. The user can already tune that via env if they want a longer recovery window.
- A new lifecycle tag to mark trashed docs. Paperless already knows, no need to mirror state.

## Decisions

### 1. Endpoint shape: per-doc actions, plus one `empty` endpoint

Four endpoints, all under `/api/trash/`:

```
GET    /api/trash/                      → paginated list
POST   /api/trash/{id}/restore          → restore one
POST   /api/trash/{id}/delete           → hard-delete one
POST   /api/trash/empty                 → hard-delete everything in trash
```

Alternatives considered:
- **One verb endpoint** (`POST /api/trash/ { documents: […], action: "restore"|"empty" }`, matching Paperless's own contract). Rejected because the SPA's natural call shape is "act on this row"; mirroring Paperless's tuple-of-ids API leaks an awkward abstraction the SPA doesn't want. We translate per-doc actions into single-element list POSTs inside the gateway.
- **Soft-delete via `POST /api/trash/{id}/delete`-style symmetry** (every state transition is a POST under `/api/trash/`). Rejected because the existing `DELETE /api/documents/{id}` is already wired in the SPA and is the right verb for "move this to trash". We don't move that endpoint; we add the trash routes alongside.

### 2. Qdrant cleanup happens server-side, not via a second client call

When `app.state.rag_vector_store` is present, the trash service's `delete_forever(doc_id)` and `empty()` methods call `vector_store.delete_by_doc_id(doc_id)` for every id after the Paperless empty call returns 2xx. Sequence:

```
SPA  → POST /api/trash/{id}/delete
api  → POST /api/trash/ {documents: [id], action: empty}   to Paperless
api  ←   2xx
api  → vector_store.delete_by_doc_id(id)                   best-effort
api  ←   ok (or log + swallow on Qdrant error)
SPA  ← 204
```

Why Paperless first: if Paperless rejects the empty (404, conflict), the doc is still there and we don't want to have orphaned Qdrant before that's resolved. Why Qdrant best-effort: Paperless is the source of truth; if Qdrant is unreachable, the orphan is a transient annoyance, not a correctness bug, and the user can re-trigger the empty by clicking again.

Alternatives considered:
- **Have the SPA fire two requests (Paperless empty + Qdrant cleanup) directly.** Rejected on principle: the SPA never speaks Qdrant or Paperless directly today; this would also require exposing a `/api/rag/chunks/{doc_id}` DELETE endpoint that the SPA has no other reason to know about.
- **Use the auto-tagger's indexer task to delete on a trash event.** Rejected because there is no trash event; we'd have to poll, which is exactly the kind of latency we just fixed in `code-review-cleanups`. Inline server-side cleanup is direct.

### 3. The `delete_forever` path uses Paperless's `empty` action, not a different verb

Paperless's `/api/trash/` accepts `action: "restore" | "empty"` only — there is no "delete" verb. To hard-delete a single doc we POST `{documents: [id], action: "empty"}`. This is the gateway's `empty_trash(doc_ids=[id])`. The SPA's per-row "Endgültig löschen" maps to `POST /api/trash/{id}/delete`, which inside the service calls `empty_trash([id]) + vector_store.delete_by_doc_id(id)`. Naming asymmetry is intentional: the gateway speaks Paperless's vocabulary, the router speaks the user's.

### 4. Count badge polls `GET /api/trash/?page_size=1`

Cheap (one row of metadata) and the response carries `count` at the top level so the badge reads the same field the in-flight pill reads. Same 30-second `staleTime` to match the existing nav-polling cadence so we don't add another timer the user has to reason about.

Alternatives considered:
- **A dedicated `GET /api/trash/count` endpoint.** Rejected as unnecessary plumbing — `?page_size=1` is one cheap query and the spec stays smaller.
- **SSE / WebSocket push for trash mutations.** Rejected; the existing polling cadence is fine at this data rate (a personal DMS sees a few dozen deletes a month).

### 5. Mutation cache invalidation: invalidate by query-key prefix

After any trash mutation, invalidate:
- `["trash"]` — the list itself
- `["library"]` — restore brings a doc back into the library; empty leaves it out
- `["inbox"]` — same reasoning if the doc was `ai-pending` when soft-deleted (uncommon but possible)
- `["in-flight"]` — restore can put a still-pending doc back in the worker's view
- `["document", id]` — per-doc preview / detail caches if the user has the modal open

Mirrors the `useDeleteDocument` hook's invalidation set. No new pattern.

### 6. Time-to-auto-purge surfaced in the row, computed client-side

Paperless exposes the soft-delete timestamp on each trash item (the field is `deleted_at` in the response). The SPA computes `days_left = PAPERLESS_EMPTY_TRASH_DELAY - (now - deleted_at).days`. The default is 30. We render "noch N Tage" per row. We do NOT fetch `PAPERLESS_EMPTY_TRASH_DELAY` from the Paperless config endpoint — that's an unauthenticated server-side concern; hard-code 30 with a comment pointing to the env var. If the user has overridden the delay, the badge will be approximately wrong but never dangerously wrong (always undershooting in our favour).

Alternative: ship the actual config value via a new `/api/config` endpoint and parse it in the SPA. Out of scope for this change — `30` is the documented default and the cost of being wrong is "shows '5 Tage' when it's actually '7 Tage'" — cosmetic.

## Risks / Trade-offs

- **[Existing SPA "Löschen" copy was wrong]** → Mitigation: update the confirm-dialog text to "Wird in den Papierkorb verschoben". Users who deleted before this change won't see history retroactively but going forward the verb means what they think it means.
- **[RAG retrieval still surfaces chunks of trashed-but-not-emptied docs]** → Mitigation: document as a known limitation in CLAUDE.md and the user-facing /ask UI footer. Real fix is a follow-up. Risk mitigated by the fact that the user can hit `Papierkorb leeren` to dismiss it instantly.
- **[Qdrant best-effort cleanup can leave orphans if Qdrant is briefly down]** → Mitigation: every retry of `Endgültig löschen` on an already-Paperless-empty doc is a no-op on Paperless's side (the doc is already gone) but DOES re-run the Qdrant cleanup, so the user can self-heal by clicking again. A follow-up `scripts/cleanup-orphaned-rag-chunks.py` can be the operator's escape hatch.
- **[Restore re-introduces a doc whose AI fields point to stale lookups]** → Paperless's restore preserves all custom fields and tags; the doc looks exactly as it did before the soft-delete. The auto-tagger's poller will NOT re-extract a restored doc because it carries a lifecycle tag. If the user wants a fresh extraction, they hit Reprocess on the restored doc the same way they would for any other doc. No new code needed.
- **[Concurrent empty + restore races]** → Mitigation: both server endpoints translate to a Paperless POST; Paperless itself serializes them. If empty wins the race, restore returns 404 and the SPA shows "Dokument nicht mehr im Papierkorb". Idempotent enough at this scale.

## Migration Plan

1. **Gateway methods + tests** — pure additions, no live recreate needed. Run gateway tests locally.
2. **Trash service + router + tests** — pure additions, register the new router under `/api` in `main.py`.
3. **`get_vector_store_optional` dependency** — added once, used by the trash service. Tests stub it.
4. **Recreate `aktenraum-api`** — task: `task api:rebuild`. New endpoints become reachable.
5. **SPA route + lib + nav link + copy edit** — lazy route, build with `pnpm --filter @aktenraum/web build` to confirm no breakage; live verify with `task web:dev`.
6. **Manual smoke test**: soft-delete a doc → visible in `/trash` → restore → back in `/library`. Then soft-delete again → Endgültig löschen → gone from `/trash`. Confirm `vector_store.delete_by_doc_id` was called via the auto-tagger / aktenraum-api log.
7. **CLAUDE.md + session note** — last commit per project commit discipline.

Rollback per step is a pure revert (every commit is independent of the next once gateway methods exist).

## Open Questions

- Should the trash list paginate at 20 (matches inbox) or 50 (matches library)? Lean 20 — a personal DMS rarely accumulates more than a screen of trash, and 20 matches the cadence the user already trained on.
- Should "Papierkorb leeren" require typing "leeren" to confirm, or just a single-screen "Wirklich alle 17 Dokumente endgültig löschen?" with two buttons? Lean the second — Paperless's own UI does the same and the action is reversible only if the user is fast.
- Does the existing `useDeleteDocument` mutation need its German copy changed inline in this PR, or do we leave the modal as-is and just rely on the new trash page being self-explanatory? Lean inline copy change — the misleading message is the bug; leaving it in is a half-fix.
