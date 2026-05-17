## Why

Three small Library-experience issues that share the same files and ship cleanest as one unit:

1. **Auto-accept appears broken.** Live corpus has zero docs with `ai-auto-approved` despite `AUTO_APPROVE_TYPES=Rechnung,Kontoauszug` + `AUTO_APPROVE_CONFIDENCE=0.95` in the env. The routing code is correct and unit-tested, BUT every existing doc was uploaded before the current type-allowlist gate was reintroduced (audit-hardening pass on 2026-05-16), so the data we have can't tell us whether it works on a fresh upload. The bug — if there is one — only surfaces on the next Rechnung. We don't have observability to diagnose it after the fact: the auto-tagger logs `routing_decision` but only with `tags=` and `confidence=`, never *why* the auto-approve gate refused.

2. **No sort UI in the Library.** Backend supports `-created, created, -modified, modified, title, -title`; the SPA hard-codes `-created`. Users who want to find an old contract by title or sort by recently-edited can't.

3. **A doc being processed by the auto-tagger sits wherever its sort order lands.** When the user uploads a new doc, the row often ends up on page 3 or later (depends on `created_date` from OCR — historical Rechnungen routinely land in 2024/2023). The user has to paginate to watch it land. The Nav badge says "1 in Bearbeitung" but the doc itself is hidden.

## What Changes

### Auto-approve observability (no behaviour change)

- **Extend `_route_lifecycle_tags` to also return a structured `reason` string** explaining the decision: `"auto_approved"`, `"allowlist_empty"`, `"type_not_in_allowlist"`, `"confidence_below_threshold"`. Pure refactor — no routing change.
- **`process_document` logs `routing_decision`** with `tags=`, `confidence=`, `document_type=`, AND the new `reason=`. So the next time the user uploads a Rechnung that doesn't auto-approve, one grep of `docker compose logs auto-tagger | grep routing_decision` tells us whether the type allowlist or the confidence threshold blocked it.
- **Add `ai_routing_reason` Pydantic-coerced field to the auto-tagger** that we PATCH onto the doc alongside `ai_confidence` so the SPA can surface it on the per-doc detail page (Library `/library/$id` and Inbox detail). One-line read-only label: "Routing-Grund: type_not_in_allowlist". No new Paperless custom field is required — surface it via the existing `ai_confidence_reason` longtext field for now (prepend with a tagged line) OR add it to the in-memory routing log only. Decision in design.md.

### Library sort dropdown

- **New `ordering` URL search-param** in `apps/web/src/router.tsx`'s `validateSearch`, coerced against the existing backend allowlist (`-created`, `created`, `-modified`, `modified`, `title`, `-title`). Persisted in URL state like every other filter so it's bookmarkable.
- **New `<select>` "Sortierung" control** in the Library header next to the existing filter inputs. Six options with German labels:
  - `Erstellt (neueste zuerst)` (default) → `-created`
  - `Erstellt (älteste zuerst)` → `created`
  - `Geändert (neueste zuerst)` → `-modified`
  - `Geändert (älteste zuerst)` → `modified`
  - `Titel (A → Z)` → `title`
  - `Titel (Z → A)` → `-title`
- **Inbox tab's "Zur Prüfung" list keeps its own default** (`-modified`, oldest-pending-first feel). Out of scope.

### Pin in-flight docs to first page (server-side)

- **`/api/library/`'s service** now optionally fetches `/processing` from the auto-tagger via the existing HTTP client (`AUTO_TAGGER_URL`) when `page=1`. Active worker ids (extraction + propagation + indexer slots) are fetched as individual `LibraryItem` projections, prepended to the page-1 results, de-duped against the naturally-sorted page contents.
- **Active worker ids only** (the auto-tagger's `ProcessingState`), not the broader `ai-pending|ai-approved` set — those are already surfaced in the Inbox tab / In-Bearbeitung pill, and we don't want to flood page 1 of the archive with every queued doc.
- **`LibraryItem` gains an `is_processing: bool` field** so the SPA can render the existing `ProcessingBadge` spinner on the pinned rows. Defaults to False for naturally-sorted rows.
- **Pagination stays consistent**: the pinned doc IS removed from any later page where it would naturally fall, so the user sees it exactly once. Achieved by passing the in-flight ids as `tags__id__none` AT THE PAPERLESS LEVEL when fetching natural-sorted rows — but that would exclude them after they finish processing too, so instead we filter client-side on the fetched page: drop any natural row whose id is in the in-flight set (page-2+ pages still might show the doc if it finished processing between the page-1 fetch and the page-2 fetch — acceptable; the user is paging through a moving target either way).
- **Page 2+ behaviour unchanged**: server-side prepend only fires on `page=1`.
- **Auto-tagger reachability is best-effort**: if `/processing` errors / times out (2s budget), the library falls back to plain natural-sorted results. Same pattern as `/documents/processing` already uses.

## Capabilities

### New Capabilities
None — extends existing `auto-tagger` and `aktenraum-api` / `aktenraum-web` capabilities.

### Modified Capabilities
- `auto-tagger`: routing logs MUST include the reason the auto-approve gate did or didn't fire.
- `aktenraum-api`: `GET /api/library/` MUST pin currently-processing docs to the top of page 1 with an `is_processing` marker; MUST accept the existing `ordering` allowlist via the `ordering` query param.
- `aktenraum-web`: Library page MUST render a Sortierung control; MUST render the processing spinner on pinned in-flight rows.

## Impact

- **Code (backend)**:
  - `services/auto-tagger/src/auto_tagger/tagger.py` — `_route_lifecycle_tags` returns `(tags, reason)`; `process_document` logs the reason
  - `services/auto-tagger/tests/test_tagger.py` — extend the parametrised routing matrix with the reason column
  - `services/aktenraum-api/src/aktenraum_api/library/schemas.py` — `is_processing: bool` on `LibraryItem`
  - `services/aktenraum-api/src/aktenraum_api/library/service.py` — page-1 prepend + dedupe
  - `services/aktenraum-api/src/aktenraum_api/library/router.py` — pass the auto-tagger URL / settings through
  - `services/aktenraum-api/tests/test_library_router.py` — add cases for pinned-row prepend, dedupe, fallback when auto-tagger unreachable
- **Code (frontend)**:
  - `apps/web/src/router.tsx` — add `ordering` to `LibrarySearch` and `validateSearch`
  - `apps/web/src/lib/library.ts` — pass `ordering` through; add `is_processing` to the `LibraryItem` type
  - `apps/web/src/routes/Library.tsx` — Sortierung dropdown in the header; render the existing `ProcessingBadge` on rows with `is_processing`
- **Docs**:
  - CLAUDE.md gotchas — note the new routing-reason log key for diagnosing auto-approve issues
  - Session note when shipped
- **Out of scope** (intentionally):
  - Changing the auto-approve gate (type allowlist stays in place per the audit hardening rationale)
  - Inbox / Zur Prüfung tab sort
  - Duplicate flagging — separate change after these three land
  - Multi-column sort (rare at personal-DMS scale)
