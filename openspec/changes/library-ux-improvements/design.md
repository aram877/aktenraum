## Context

Three small bugs that share the Library code path. The user picked one bundled change for momentum.

Current state, for grounding:

- **Auto-approve routing**: `tagger._route_lifecycle_tags` returns just `list[str]`. The caller logs `routing_decision tags=… confidence=…` but never *why* the auto-approve gate did or didn't fire. The gate is `bool(auto_approve_types) AND doc_type ∈ allowlist AND confidence ≥ threshold` — three reasons it can fail and the logs can't distinguish them.
- **Library sort**: backend allowlist is `{-created, created, -modified, modified, title, -title}` enforced at `library/router.py:18-25`. SPA hard-codes `ordering: "-created"` in `apps/web/src/routes/Library.tsx:95`. URL search params already exist for every filter; `ordering` is the only one missing.
- **In-flight pin**: `/api/library/` doesn't know about active processing today. The auto-tagger exposes `/processing` (port 8001 inside the network) returning `{processing: [ids], slots: {extraction, propagation, indexer}}`. `documents/router.py:335` already proxies this via `httpx.AsyncClient(timeout=2.0)` with best-effort fallback — same shape we reuse.

## Goals / Non-Goals

**Goals:**
- Next failed auto-approve produces a single grep-able log line with the precise reason.
- Library users can sort by any of six existing backend-allowed orderings via a dropdown, persisted in URL state.
- A doc the auto-tagger is *actively working on* (in one of the three worker slots) appears as row 1 of page 1 with a spinner — regardless of how the rest is sorted.
- All three changes ship without changing auto-approve routing behaviour.

**Non-Goals:**
- Surfacing the routing reason in the SPA per-doc detail page. Logs are enough for the user to diagnose; we can add the field later if it becomes a recurring pain point.
- Pinning every `ai-pending|ai-approved` doc to page 1 (those live in the In-Bearbeitung pill and the Zur-Prüfung tab; the library archive only pins the narrow set the worker is actively touching).
- Multi-column or stable-tiebreaker sort. The Paperless ordering values are the contract.

## Decisions

### 1. Routing reason: enum-shaped strings, log-only for now

`_route_lifecycle_tags` returns `(tags: list[str], reason: str)`. Reason values:

- `"auto_approved"` — gate passed; both conditions true.
- `"allowlist_empty"` — `AUTO_APPROVE_TYPES` is empty; gate disabled by config.
- `"type_not_in_allowlist"` — allowlist non-empty but doc type not in it.
- `"confidence_below_threshold"` — type allowed but confidence < threshold. Includes the `ai-low-confidence` sub-case (which is information for the user, separate from the reason).

`process_document` logs `routing_decision tags=… confidence=… document_type=… reason=…`. Pure additive log change; no new fields written to Paperless.

Alternatives considered:
- **Surface the reason as a new Paperless custom field.** Rejected: every new field is migration cost + bootstrap-paperless change + LIBRARY/INBOX detail-page rendering. The reason is operator-facing diagnostic data; logs are the right surface.
- **Append the reason to `ai_confidence_reason`.** That field is the LLM's own explanation of its confidence number — overloading it with routing metadata would muddle the meaning and risk the SPA rendering it inline. Skip.

### 2. Library sort: URL state, six options, default `-created`

`LibrarySearch` in `apps/web/src/router.tsx` already validates every other filter from `?...` to a typed shape. Add `ordering` with the same pattern: parse string, reject anything not in the allowlist, default `-created`. The Library page reads `search.ordering ?? "-created"`, passes to `useLibraryList`, and renders a `<select>` whose `onChange` calls `navigate({ search })`.

Alternatives considered:
- **In-memory sort dropdown that doesn't touch the URL.** Rejected — every other Library knob is URL state; breaking the pattern would be surprising for back-button users.
- **Reuse the backend's response order without a UI control.** That's what we have today and it's the bug.

### 3. In-flight pin: page-1 only, server-side prepend, dedup at the Paperless boundary

The library service's `list_library_items(...)` already pages Paperless results. On `page == 1`, additionally:

1. Fetch `${AUTO_TAGGER_URL}/processing` via httpx (2 s timeout, X-Aktenraum-Secret header). On any error → fall through to plain results.
2. Take `processing[]` ids; for each id call `gateway.get_document(id)` and project into a `LibraryItem` with `is_processing=True`.
3. Drop any natural-result rows whose id is in the in-flight set (so the doc isn't shown twice).
4. Return `pinned + filtered_natural` as the page-1 `results`. The Paperless `total` is unchanged — we don't fake the count just because we reordered.

On `page >= 2`, behave exactly as today (no pinned rows, no Paperless call to `/processing`). Pagination keeps working because the pinned doc was already filtered out of the natural page-1 list, so the "first 20 natural rows minus the in-flight ones" plus "the pinned in-flight rows" lands on page 1; page 2 starts at natural row 21 as if nothing happened.

Edge cases:
- Pinned doc was on page 5 in natural order. Server-side fetch + page-1 prepend surfaces it. User pages to 5 → it's still there in its natural place, but we strip it (it's also in the in-flight set, so the page-1 dedupe applied; on page 5 we don't have the in-flight set fetched because we skipped the call → it stays). Acceptable: the doc shows once on page 1, once on page 5. Real fix is "always fetch in-flight ids and dedupe on every page", which we DO implement because the cost is the same one HTTP round-trip.
- Pinned doc finishes processing between page-1 fetch and a tab-switch refresh. The dedupe set is stale → the doc could appear twice for one refresh. The user's next refetch (30s `staleTime`) cleans up. Acceptable.
- Filter is active (`document_type=Rechnung`) AND a non-Rechnung doc is being processed. We still pin it — the user's intent is "show me what's happening now" regardless of filters. The pinned row's projection includes its actual fields so the user sees that it's a non-Rechnung pinned by-design.

Alternatives considered:
- **Client-side separate "Wird gerade verarbeitet" section.** Cleaner visually but doesn't integrate with the existing Library grid → sticks out, requires its own empty state, doesn't survive the user clicking through to detail and back. Rejected; user picked server-side.
- **Add a synthetic high-priority sort key inside Paperless.** Paperless doesn't support custom sort keys; the only way to pin is at the application layer.
- **Use `ai-pending|ai-approved` instead of the narrow `/processing` slots.** Rejected per the goal: the user wants the row the AUTO-TAGGER IS WORKING ON RIGHT NOW, which is the worker-slot set. Broader sets already surface in In-Bearbeitung / Zur Prüfung.

### 4. Settings + WEBHOOK_SECRET parity

The library router already has `settings: Settings = Depends(get_settings)` via the existing reprocess-trigger pattern. The `auto_tagger_url` + `webhook_secret` plumbing is identical to what `documents/router.py::reprocess` and `inbox/router.py::approve` use. New change: import `httpx` (if not already), wrap the `/processing` call in the existing best-effort pattern.

## Risks / Trade-offs

- **[Server-side pin adds one Paperless fetch per pinned doc on page-1]** → Mitigation: pinned set is by definition ≤ 3 (extraction/propagation/indexer slots), so it's ≤ 3 extra Paperless GETs per page-1 load. Negligible at personal-DMS scale. Bigger payloads at scale would warrant batching, not relevant here.
- **[Auto-tagger unreachable → no pin → silent degradation]** → Mitigation: matches existing `/documents/processing` pattern; logged at `info` (not `warning`) because it's a normal startup state. The library page works regardless.
- **[Sort dropdown adds URL noise on every change]** → Mitigation: history goes through TanStack Router's `navigate({ search })`, which uses `replace: false` by default. Acceptable: dropdown changes are user actions and SHOULD be in history.
- **[Logging the reason might leak operator-facing data into a future structured-log pipeline]** → Mitigation: the reason values are a closed enum of internal strings, no user content. Safe.

## Migration Plan

1. **Auto-tagger routing reason** — pure internal refactor; tests adjust to the new tuple shape; rebuild auto-tagger; no Paperless-side changes.
2. **Library sort URL plumbing** — backend already supports the param; SPA changes only. Build + deploy.
3. **Library in-flight pin** — backend service change + new `is_processing` field. Run aktenraum-api tests, rebuild api container, smoke through nginx.
4. **SPA: render dropdown + spinner on pinned rows** — last step, after the API change is live.
5. **CLAUDE.md + session note** — final commit per project commit discipline.

Each step is independently revertible; rollback is a plain revert of its commit.

## Open Questions

- Whether the Sortierung dropdown should also appear on the Zur-Prüfung tab inside the Library. Lean no — the review queue has a stable "oldest first" feel that's the right default and we don't want to clutter that mode. Resolve in PR review.
- Whether pinned rows should ALSO be excluded from later pages via a server-side `tags__id__none` parameter. Lean no — see edge-case discussion above; the cost of the extra HTTP call on page 2+ outweighs the once-in-a-while double-row, which a 30 s staleTime refresh fixes anyway.
