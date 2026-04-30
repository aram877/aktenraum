## Context

The auto-tagger writes `ai-pending` against every freshly classified document. Today the only way to clear that queue is to open Paperless's admin UI, find the tag, edit twelve unlabelled custom fields, and swap a tag — slow, error-prone, and the exact friction the rewrite exists to remove. Phase 3 builds the workflow that actually makes the AI layer trustworthy: a focused, keyboard-driven review queue.

The mechanism is deliberately mundane — a list endpoint, a detail endpoint, a partial-update endpoint, two action endpoints, a preview proxy. No new model, no new state, no new infra. The propagation watcher already does the heavy lifting downstream; this phase just stops the user from having to click through Paperless's admin UI to set the tag.

## Goals / Non-Goals

**Goals:**
- A logged-in user opens `/inbox`, sees N pending docs, and can clear them in a few keystrokes each.
- The two-pane review page renders the PDF preview alongside an editable form for the twelve `ai_*` fields. Approve and Reject are one keystroke each.
- Edits made on the form propagate into Paperless's native fields (post-approval) via the existing watcher — no second mechanism.
- Auto-advance: after Approve / Reject, the SPA navigates to the next pending doc without an extra click.
- Server-side validation mirrors the auto-tagger's boundary normalisers (monetary `<ISO><amount>`, date strict ISO, string ≤128 chars) so user edits cannot trip Paperless's rejection rules.
- The Paperless API token never reaches the browser — the preview is proxied.

**Non-Goals:**
- Multi-document selection / batch approve. One doc at a time is enough at personal scale; batch is a Phase 5 concern.
- Re-running extraction from inside the review UI. If the user wants a redo, they clear the lifecycle tags via Paperless and let the poller re-enqueue. We can layer a "redo" button later.
- Editing native Paperless fields directly (correspondent FK, document_type FK, tags). The flow is: edit `ai_*` → Approve → propagation watcher writes the natives. Two paths into the same fields would be confusing.
- A diff view of "AI vs. user-edited" values. The form shows the AI's values pre-filled; the user's edits become the new value. We track the AI's confidence on the form so they can see at a glance how much to trust each field.
- Undo. Once a doc is approved or rejected the lifecycle tag is set and the propagation kicks. If the user mis-clicks they can clear tags in Paperless to restart. Adding undo would require a second state machine.
- A websocket / SSE feed for live queue updates. Polling + invalidation on mutation is enough.

## Decisions

### D1 — `/api/inbox/*` is a thin wrapper around the gateway, not a second source of truth

Every endpoint reads or writes Paperless via the gateway and projects the result. We don't store the queue in the API's Postgres. Why: the auto-tagger already owns the lifecycle-tag state machine, and duplicating it in `aktenraum-api`'s DB invites drift. The cost (one Paperless round-trip per page load) is irrelevant at personal scale.

The schemas (`InboxItem`, `InboxDetail`, `InboxFieldUpdate`) are presentation projections. They map back to the same `ai_*` custom fields the auto-tagger writes; we don't try to abstract those names away.

### D2 — Field-update validation lives in `aktenraum-core` and runs server-side at the boundary

The auto-tagger's `aktenraum_core.paperless.normalisers` already normalises monetary, dates, and string-length truncation. We reuse those *exactly*. The API runs them on every `PATCH /api/inbox/{id}` body before sending to Paperless; the client cannot bypass them.

This means a user typing `01.12.2024` into the issue-date field is silently corrected to `2024-12-01`. We surface the normalised value in the PATCH response so the SPA can update its form state without a second GET.

Alternative considered: client-side validation only. Rejected — the SPA would have to mirror the rules, and any mismatch becomes a Paperless 400 the user sees but doesn't understand. Server-side normalisation is the right place.

### D3 — Approve = optional patch + lifecycle-tag swap, in that order

`POST /api/inbox/{id}/approve` accepts an optional `InboxFieldUpdate` body. The handler:

1. If body present and non-empty → call the patch logic.
2. Read current tag list.
3. Replace `ai-pending` with `ai-approved` (and remove `ai-low-confidence` if present).
4. Return the updated InboxDetail.

If the patch fails, we do not flip the tag. If the patch succeeds and the tag swap fails, we tag `ai-propagation-error` so the user can see something is broken without losing the edit. The propagation watcher picks up `ai-approved` within 30s.

### D4 — Lifecycle-tag swap is a single PATCH against `tags=[…]`

`swap_lifecycle_tag(id, *, remove: list[str], add: list[str])` reads the current `tags` array, applies the swap (removing tag ids whose names match `remove`, adding tag ids for `add`), and PATCHes once. Auxiliary tags (e.g. `ai-low-confidence`) are removed via the `remove` list. The lifecycle-tag set is the canonical six (`ai-pending`, `ai-approved`, `ai-rejected`, `ai-propagated`, `ai-propagation-error`, `ai-error`) — same constants the auto-tagger uses (imported from `aktenraum_core.paperless`).

Race protection: the auto-tagger's worker re-checks lifecycle tags on dequeue; if a user approves a doc while the worker is mid-extraction, the worker's PATCH might overwrite the user's `ai-approved` with `ai-pending` and the user with `ai-approved`. The win-condition there is "whoever PATCHed last", and at personal scale collisions are extremely rare. If we ever see them in logs we add an `If-Match`-style read-write guard, but YAGNI for now.

### D5 — PDF preview is proxied through aktenraum-api

`GET /api/inbox/{id}/preview` opens an httpx stream to `<paperless>/api/documents/{id}/preview/` with the API token in headers, and forwards bytes to the SPA with `Content-Type: application/pdf` and `Cache-Control: private, max-age=300`. We use `StreamingResponse` to avoid buffering big PDFs in memory.

Why not let the browser hit Paperless directly with the cookie? Paperless's auth uses a different token and doesn't trust our JWT cookie. Sharing a token to the browser breaks the "API token never leaves the API container" invariant from Phase 1. A 5-minute private cache means the iframe doesn't re-request on every navigation back to the same doc.

### D6 — Low-confidence is a presentation flag, not a separate state

The auto-tagger applies `ai-low-confidence` *alongside* `ai-pending` when extraction confidence is below threshold. The SPA reads the tag list and renders a small badge on rows / a banner on the review page. On Approve, the swap removes both `ai-pending` and `ai-low-confidence`.

We surface the raw `ai_confidence` value in `InboxItem` and `InboxDetail` too, so the form can render the per-field certainty (e.g. dim text + a tooltip when confidence < 0.7).

### D7 — Auto-advance on Approve / Reject

After a successful Approve or Reject, the SPA looks up the next `ai-pending` doc id (it has the cached list from `/api/inbox/`) and navigates there. If the user just cleared the last doc, the page redirects to `/inbox` showing the empty-state. The current doc id is read from the URL, so a refresh works.

We do *not* prefetch the next doc's preview — Paperless's preview generation is fast, and prefetching would consume bandwidth on docs the user might never reach.

### D8 — Keyboard shortcuts use a single global handler with focus exemptions

A `useKeyboardShortcuts` hook attaches one `keydown` listener to the document. Bindings: `a` Approve, `r` Reject, `j` next, `k` prev, `Escape` back to list. The handler short-circuits when the active element is an `input`, `textarea`, or has `contenteditable`. No fancy library — the spec is small enough to live in one component.

We don't ship a keybinding-customisation UI; if a user wants different keys they edit the file. Multi-user (Phase 5+) would need per-user keymap.

### D9 — Test strategy

- **Pure-function tests** for `swap_lifecycle_tag`'s pure planner (input: current tag ids + name lookup + remove/add lists; output: new tag id list).
- **Schema tests** that `InboxFieldUpdate` round-trips through the auto-tagger's normalisers without surprise.
- **Router tests** for each endpoint, with a fake gateway and a fake Paperless response stream. We mock `httpx.AsyncClient.get` / `.patch` on the gateway via `unittest.mock`, the same shape as the Phase 2 `test_ai_router.py`.
- **Preview-proxy test** asserts the route requires the cookie, the upstream URL is the right one, the response uses `StreamingResponse` with the right content-type, and bytes pass through unchanged.

We continue to skip live Paperless in CI; Phase-2's pattern of fake gateways + dependency overrides covers the new endpoints cleanly.

### D10 — SPA architecture mirrors Phase 2

`apps/web/src/lib/inbox.ts` exposes `useInboxList()`, `useInboxDetail(id)`, `useInboxPatch(id)`, `useApprove(id)`, `useReject(id)` — all TanStack Query hooks. `routes/Inbox.tsx` for the list, `routes/InboxReview.tsx` for the detail. A small `useKeyboardShortcuts` hook sits in `apps/web/src/lib/keyboard.ts`. Cache invalidation: every approve / reject invalidates the list query so the count badge updates.

## Risks / Trade-offs

- **PDF preview proxy adds bandwidth on the API container.** Roughly the size of each preview times the number of times the user navigates back to it inside the cache window. At personal scale this is negligible; if it ever becomes a problem we can move to a presigned-URL pattern (Paperless behind nginx, with a server-validated token query param).
- **The lifecycle-tag swap is non-atomic across multiple concurrent reviewers.** Single-user assumption holds for now. When auth goes multi-user, the Approve handler should read the doc, check that `ai-pending` is still set, and 409-conflict otherwise. Easy to add when needed.
- **Server-side normalisation can silently change a user's input.** Counter-balance: the response body returns the normalised value, the form re-renders with that, and the user sees the change immediately. The SPA can show a small "✓ corrected" badge on each normalised field — not in scope for this phase, but easy follow-up.
- **No undo.** A mis-clicked Approve is recoverable only via Paperless admin (clear tags, re-extract). If users miss-click often we add a 5-second undo banner — but the keyboard layout (a / r are far apart on QWERTZ and QWERTY) keeps mis-clicks rare.

## Migration / Rollout

For any install (no env changes, no DB changes):

1. `git pull && cd docker && docker compose up -d --build aktenraum-api nginx`. The Python source change requires the API rebuild; the SPA bundle gets the new routes via the nginx multi-stage build.
2. Browse to `http://localhost:8080/inbox`. Pending docs render. Click one (or press Enter / J), review, Approve / Reject, repeat.

Verification:
- `curl -s http://localhost:8080/api/openapi.json | jq '.paths | keys'` includes `/api/inbox/`, `/api/inbox/{id}`, `/api/inbox/{id}/approve`, `/api/inbox/{id}/reject`, `/api/inbox/{id}/preview`.
- `GET /api/inbox/` (with auth cookie) returns the same set of pending docs that `curl -H "Authorization: Token …" http://localhost:8000/api/documents/?tags__id=<ai-pending-id>` returns.
- Approving a doc via the SPA and waiting 30s shows it move to `ai-propagated` (propagation watcher fired) — same as before, confirming the watcher is untouched.
