# ADR-006 — Drop the mobile document-scan feature

- **Status**: Accepted
- **Date**: 2026-08-11
- **Deciders**: maintainer

## Context

`/scan` shipped as Phase 1 of the `mobile-document-scan` change: an
`<input type="file" accept="image/*" capture="environment">` camera capture, a
thumbnail grid with reorder / rotate / crop / delete, and client-side PDF
composition via `pdf-lib`, uploading through the existing
`POST /api/documents/upload` with no backend changes. Phase 2 (auto
edge-detection + perspective correction via `jscanify` + OpenCV.js, ~8 MB
lazy chunk) was attempted and reverted in `ec580a4`.

The Node.js/Angular rewrite (`rewrite-stack-nodejs-angular`) reached the point
where every React route had to be ported to Angular. `/scan` was task 5.7 and
the single most expensive remaining route: camera capture, a crop modal, canvas
rotate/crop, and a second PDF-composition library in the Angular ecosystem — all
to reproduce a feature whose Phase 2 polish had already been abandoned.

## Decision

**Remove the scan feature entirely rather than port it.**

Deleted from `apps/web`: `routes/Scan.tsx`, `lib/scan-pdf.ts`,
`lib/scan-reducer.ts`, `lib/scan-types.ts`, the Nav icon and mobile-drawer
entry, the Home card, the now-orphaned `CameraIcon`, and the `pdf-lib` +
`react-image-crop` dependencies. The `mobile-document-scan` OpenSpec change is
archived at `openspec/changes/archives/2026-08-11-mobile-document-scan-cancelled/`
with a cancellation banner on its proposal. Task 5.7 of the rewrite is marked
cancelled, not deferred.

## Consequences

- **The mobile capture path is now "photograph with the OS camera, then upload
  via `/upload`"** — the pre-scan workflow. Multi-page documents become N
  separate images that Paperless will not merge, which was the original
  motivation for the feature. That regression is accepted.
- The Angular port drops its most expensive remaining route, and the React
  bundle loses 11 modules plus two dependencies.
- Reversing this is not free: the implementation is recoverable from git
  history and the archived change still documents the reasoning, but the
  Angular port would have to be written from scratch.
- Any future scan feature should be re-proposed against the Angular stack
  rather than resurrecting the React implementation.
