---
name: lifecycle-tag-state-machine
description: Use when working on the auto-tagger, propagator, indexer, or any code that reads/writes Paperless tags to drive the AI pipeline. Documents the 6 lifecycle tags + 2 auxiliary markers, the state-machine semantics (what each tag means, valid transitions, who owns each transition), the swap-then-verify idempotency pattern, the asyncio.shield() requirement around lifecycle PATCHes, and the reprocess flow. Triggers when editing services/auto-tagger/src/auto_tagger/{tagger,propagator,indexer,main}.py, services/aktenraum-api/src/aktenraum_api/inbox/service.py, or paperless_gw.swap_lifecycle_tag.
---

# Lifecycle-tag state machine

A document's "where am I in the AI pipeline" is encoded **entirely** in its Paperless tags. There is no separate state table. Every background loop in the auto-tagger and every action in the inbox UI is just code that **watches for one tag and produces another**.

This is the mental model: tags are the state machine. All other state (custom-field values, indexed chunks) is derived.

---

## The 8 tags

Six form the lifecycle (mutually exclusive — a doc carries at most one). Two are auxiliary markers (live alongside a lifecycle tag).

```
(no tag)                  ← just uploaded, AI hasn't looked yet
ai-pending                ← AI extracted; awaiting human review (in the Inbox)
ai-approved               ← user approved; propagator will run                  (transient ≤30s)
ai-rejected               ← user rejected; no propagation                       (terminal)
ai-propagated             ← native fields written; fully filed                  (terminal success)
ai-error                  ← extraction crashed                                  (terminal failure; retry by clearing)
ai-propagation-error      ← extraction OK but native-fields write failed       (terminal failure)
```

Auxiliary (never replace a lifecycle tag — they coexist):

```
ai-low-confidence         ← coexists with ai-pending; UI sorts these to top of inbox
ai-auto-approved          ← pinned through approval+propagation; UI renders "Auto-genehmigt" forever
```

Defined in `packages/aktenraum-core/src/aktenraum_core/paperless/client.py`:

```python
LIFECYCLE_TAGS = (
    "ai-pending",
    "ai-approved",
    "ai-rejected",
    "ai-propagated",
    "ai-propagation-error",
    "ai-error",
)
# Auxiliary markers are NOT in LIFECYCLE_TAGS — the poller's "no lifecycle tag"
# filter must not be affected by them.
```

---

## State transitions (who does what)

```
                                    (no tag)
                                       │
                                       │  auto-tagger.tagger:process_document
                                       │  + auto-approve heuristic
                                       ▼
                          ┌────────────┴────────────┐
              confidence ≥ AUTO_APPROVE          else
              AND doc_type ∈ AUTO_APPROVE_TYPES
                          │                         │
                          ▼                         ▼
                ai-approved + ai-auto-approved   ai-pending [+ ai-low-confidence]
                          │                         │
                          │              ┌──────────┴──────────┐
                          │              ▼                     ▼
                          │       inbox approve         inbox reject
                          │   (aktenraum-api)           (aktenraum-api)
                          │              │                     │
                          │              ▼                     ▼
                          ▼         ai-approved           ai-rejected (terminal)
            auto-tagger.propagator:
            process_approved_document
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
        propagation OK      propagation FAILED
                │                   │
                ▼                   ▼
        ai-propagated      ai-propagation-error
                │           (terminal failure)
                ▼
    auto-tagger.indexer:
    index_document
                │
                ▼
    chunks upserted to Qdrant
    (no tag change — indexing is observable via Qdrant only)
```

Extraction failure path: `(no tag) → ai-error` via `paperless.add_tag_to_document(doc_id, "ai-error")` in `tagger.py:process_document`.

---

## Who owns each transition

| Transition | Owner | File:function |
| --- | --- | --- |
| `(no tag) → ai-pending` / `ai-approved+ai-auto-approved` | auto-tagger worker | `tagger.py:process_document` → `_apply_tags` |
| `(no tag) → ai-error` | auto-tagger worker | `tagger.py:process_document` (on exception) |
| `ai-pending → ai-approved` | aktenraum-api inbox route | `inbox/service.py:approve` → `gateway.swap_lifecycle_tag` |
| `ai-pending → ai-rejected` | aktenraum-api inbox route | `inbox/service.py:reject` |
| `ai-approved → ai-propagated` | auto-tagger propagator | `propagator.py:process_approved_document` |
| `ai-approved → ai-propagation-error` | auto-tagger propagator | `propagator.py` exception handler |
| `ai-propagated → indexing in Qdrant` | auto-tagger indexer | `indexer.py:index_document` (no tag change) |
| any → cleared | aktenraum-api documents route | `documents/router.py:reprocess` → `swap_lifecycle_tag` with empty `add=` |

There's exactly one writer per transition. Don't add a second.

---

## The "every loop watches for one tag and produces another" pattern

The auto-tagger's `main.py` orchestrates four to five concurrent loops via `asyncio.gather`. Each loop's job is to consume one tag and produce another:

| Loop | Watches for | Produces |
| --- | --- | --- |
| `_extraction_worker` | dequeued doc id (no lifecycle tag) | `ai-pending` OR `ai-approved+ai-auto-approved` OR `ai-error` |
| `_extraction_poller` | docs with no lifecycle tag (every 30s) | enqueues to extraction queue |
| `_propagation_loop` | docs tagged `ai-approved` (every 30s) | `ai-propagated` OR `ai-propagation-error` |
| `_indexer_worker` | doc id from propagator | chunks in Qdrant (no tag change) |

This pattern is mandatory: if you add a new background job, it should consume exactly one tag and produce exactly one. Don't write a loop that watches for two tags or produces multiple state transitions.

---

## Idempotency requirements

Every transition must be **idempotent**: running it twice on the same doc is a no-op the second time. Concretely:

- `swap_lifecycle_tag(doc_id, remove=[X], add=[Y])` is a no-op if the doc already has `Y` and not `X`. The gateway's `_plan_tag_swap` makes this explicit.
- `process_approved_document` is **not** automatically idempotent — it writes correspondent/document_type/created_date which would change on re-run if the user edited those between approvals. The protection is the tag swap: once a doc is `ai-propagated`, the propagation loop's `get_documents_with_tag("ai-approved")` query no longer returns it.
- `add_tag_to_document` checks for existence before PATCHing.

If you add a new loop, design it to be safe under double-fire. The poller can and does enqueue the same doc id multiple times during webhook+poller races; the extraction worker dedups via `_doc_tag_names`.

---

## TOCTOU + concurrency: use `swap_lifecycle_tag`, not raw PATCH

Paperless's PATCH on `tags` is full-array replace, NOT additive. Two simultaneous writers each reading the current tag list and writing a new one will silently clobber each other's contributions.

**Always** use `PaperlessGateway.swap_lifecycle_tag` for lifecycle transitions in aktenraum-api. It:

1. Reads current tags.
2. Plans the new array.
3. PATCHes.
4. Re-reads to verify.
5. Replays on race (up to 3 attempts).
6. Raises `PaperlessConflictError` (→ HTTP 409) on the 3rd consecutive race.

The auto-tagger has its own `_apply_tags` in `tagger.py:_apply_tags` which is **additive-only** (union with existing). That's fine for extraction's initial tagging because nothing else is touching the doc yet. For state transitions (approve, propagate, error) the auto-tagger uses `paperless.patch_document_native_fields(tags=...)` after planning the full set — the propagator's `recovery_set` / `new_tag_set` pattern is the reference.

---

## `asyncio.shield()` around the lifecycle PATCH

The propagator's tag-flipping PATCH is wrapped in `asyncio.shield()`:

```python
# services/auto-tagger/src/auto_tagger/propagator.py
await asyncio.shield(
    paperless.patch_document_native_fields(
        doc_id,
        correspondent=correspondent_id,
        document_type=document_type_id,
        created_date=created_date,
        tags=sorted(new_tag_set),
        title=ai_title,
    )
)
```

Why: SIGTERM during a graceful shutdown cancels the asyncio.gather. Without shield, a cancellation between sending the PATCH and receiving the response would leave the doc with `ai-approved` cleared but `ai-propagated` not added — re-enters the pipeline on next start and may double-apply suggested tags.

If you write another loop that performs a lifecycle-flipping PATCH (e.g. a future "auto-archive" pass), wrap the PATCH in `asyncio.shield()`. SIGTERM handling in `main.py:run` already coordinates the cancellation; the shield is just the inner guarantee.

---

## The auxiliary markers — coexistence rules

`ai-auto-approved` and `ai-low-confidence` are NOT in `LIFECYCLE_TAGS`. They:

- Persist alongside a lifecycle tag.
- Are not removed by lifecycle transitions unless explicitly listed.
- The poller's "find docs with no lifecycle tag" excludes them — meaning they don't trigger re-extraction by themselves.

Specifically: `ai-auto-approved` persists `ai-pending → ai-approved → ai-propagated`, so the UI can render "Auto-genehmigt" forever. `ai-low-confidence` coexists with `ai-pending` only — the inbox approve/reject path explicitly removes it.

If you add a new auxiliary marker:

1. Pick a name with the `ai-` prefix.
2. Add it to the bootstrap script (`scripts/bootstrap-paperless.sh` `ensure_tag`).
3. Decide explicitly which lifecycle transitions strip it.
4. Update `documents/router.py:_REPROCESS_REMOVE` if reprocess should strip it.
5. Update `documents/router.py:_BADGE_TAG_NAMES` if the SPA should render a badge for it.
6. Add it to the lifecycle-tag table in `CLAUDE.md` and to `docs/workflow.md`.

Do NOT add it to `LIFECYCLE_TAGS` in `client.py` — that's mutually-exclusive territory.

---

## The reprocess flow

`POST /api/documents/{id}/reprocess` strips every lifecycle + auxiliary tag (`_REPROCESS_REMOVE` in `documents/router.py`) and pings the auto-tagger's webhook for instant re-extraction. The poller would pick it up within 30s anyway, but the webhook makes it feel instant in the UI.

Reprocess writes only the native AI fields. To re-derive native correspondent/document_type/created_date, the doc must complete the AI → approve → propagate cycle again. If a user just wants to edit the AI fields without re-running the LLM, they use `PATCH /api/documents/{id}/fields` (no lifecycle change).

---

## The "ai-pending" race protection

Webhook and poller can both enqueue the same doc id at nearly the same time. The extraction worker re-checks lifecycle tags on dequeue and skips if any are set (`_doc_tag_names` in `main.py`). This logs `skip_already_processed` and is the expected (boring) outcome of the race.

Don't try to dedup in the queue itself. The check-on-dequeue pattern is correct because:

- The webhook might arrive while extraction of a sibling doc is in flight.
- Paperless's task pipeline might fire the webhook before OCR completes.
- A user retag in the SPA might race with a worker that just dequeued.

The check on dequeue catches all three.

---

## What goes where (per state)

| Tag state | What's true | What's NOT yet true |
| --- | --- | --- |
| `(no tag)` | OCR done, `content` field has text | No AI fields yet, no native correspondent/doctype set by us |
| `ai-pending` | All 12 ai_* custom fields are populated; AI title shown as Paperless `title`? — NO, native title only writes on propagation | Native correspondent/doctype/tags not yet set |
| `ai-approved` | Same as ai-pending; user has reviewed and approved | Propagation hasn't run yet (≤30s window) |
| `ai-propagated` | Native fields written: correspondent, document_type, created_date, title. AI fields still present (not deleted) | (none — terminal success) |
| `ai-rejected` | AI fields still populated; user said no, but the data remains for reference | Native fields never written |
| `ai-error` | Document has no AI fields (extraction crashed before writing). `ai_error_message` may be set | (everything past extraction) |
| `ai-propagation-error` | AI fields present; native-fields write failed mid-flight. `ai_error_message` set | Some native fields may be partially written |

---

## Don't

- Don't add a third writer to any single transition. There's exactly one for each.
- Don't compose lifecycle tags additively. Use `swap_lifecycle_tag` for transitions.
- Don't put non-lifecycle data into a tag (e.g. don't make `ai-pending-2024` to track year). Tags are pipeline state only.
- Don't omit `asyncio.shield()` around lifecycle-flipping PATCHes in long-running workers. SIGTERM during cancel produces split-brain.
- Don't add a new auxiliary marker to `LIFECYCLE_TAGS` — that breaks the poller's "no lifecycle tag" filter.
- Don't write code that depends on `(no tag)` AND `(ai-low-confidence)` being mutually exclusive. They are, but only because nothing currently produces `ai-low-confidence` without also producing `ai-pending`. Don't bake the dependency into a new feature.
- Don't transition out of a terminal tag (`ai-rejected`, `ai-propagated`, `ai-error`, `ai-propagation-error`) without going through the reprocess flow (clears all tags).
