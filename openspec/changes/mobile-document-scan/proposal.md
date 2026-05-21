## Why

Today the only path into aktenraum from a phone is `/upload`: pick a file from the camera roll. To get a document into the system the user has to (a) open the camera app, (b) take a photo, (c) switch back to Safari/Chrome, (d) hit Upload, (e) pick the photo from the roll. For multi-page documents (contracts, salary slips, anything stapled) the friction multiplies — the user has to take N photos, remember to keep them in order, upload them as N separate images that Paperless can't merge.

Every consumer-grade DMS competitor (Genius Scan, Adobe Scan, Apple Notes "scan document", Google Drive scan) collapses this into a single in-app flow: open scanner → frame page → auto-snap → next page → review → done. The output is one PDF, ready to file. With aktenraum now reachable from mobile via Tailscale ([ADR-005](../../../docs/adr/005-test-phase-access-via-tailscale.md)) and the mobile-responsive layout shipped (commit `2e154c1`), the missing piece is the in-browser scan flow itself.

Browser camera access is mature enough on iOS Safari 14+ and Android Chrome to make this realistic without a native app: `<input type="file" accept="image/*" capture="environment">` triggers the OS camera and returns a still image; `pdf-lib` (MIT) composes the captured pages into a single PDF client-side; the resulting blob posts through the existing `POST /api/documents/upload` endpoint with **zero backend changes**. The polish question — auto edge-detection + perspective correction — is solvable with `jscanify` (MIT, OpenCV.js-based) but adds ~8 MB to the bundle and is the right thing to defer behind a lazy import.

This change is a two-phase build so phase 1 ships a working scanner in a weekend and phase 2 adds the polish only after phase 1 proves the flow.

## What Changes

### Phase 1 — Minimum-viable scanner (ships first)

- **New SPA route `/scan`** in `apps/web/src/routes/Scan.tsx`, registered in `apps/web/src/router.tsx` and exposed in the Nav next to "Hochladen" (mobile-only by default; the route renders on desktop too but the camera input falls back to a file picker, which is fine).
- **Camera capture via `<input type="file" accept="image/*" capture="environment">`** — the standard, well-supported way to invoke the OS camera from a browser. No `getUserMedia` / live video preview in phase 1; the OS camera UI handles framing.
- **Per-page state** managed in a single React component: `pages: Array<{ id: string; blob: Blob; rotation: 0|90|180|270; crop: { x, y, w, h } | null }>`. After every capture the user sees a thumbnail grid with reorder (drag) + rotate (90°) + delete + manual crop (rectangular only, no perspective).
- **PDF composition via `pdf-lib`** — for each page: load image, apply rotation + crop into a canvas, embed the canvas as a JPEG (quality 0.85) inside a single `PDFDocument`. One A4-portrait page per scan, image scaled to fit. Output is a single `Blob` of type `application/pdf`.
- **Upload via the existing `POST /api/documents/upload`** — same multipart endpoint `/upload` already uses. The PDF goes in as a single file with a generated filename (`scan-YYYY-MM-DD-HHmmss.pdf`). The post-upload polling flow (task → doc → lifecycle) is reused untouched.
- **Filename editing before upload** so the user can name the scan (defaults to the timestamped form).
- **No backend changes whatsoever**. The PDF is opaque to the API — it's just a multipart file, identical in shape to one Paperless would have received from email ingestion or the watched folder.

### Phase 2 — Auto edge-detection + perspective correction (ships after phase 1 settles)

- **Lazy-load `jscanify`** behind a dynamic `import()` so the ~8 MB OpenCV.js chunk is fetched only when the user actually opens `/scan`. The chunk is split out via a Vite manual chunk so it lives in its own file under `dist/assets/jscanify-<hash>.js` and the main bundle stays unaffected.
- **`getUserMedia`-based live preview** replaces the `<input type="file">` capture mode. The user sees a live video stream with a green overlay highlighting the detected document edges; tapping the shutter snaps the current frame, jscanify warps it to a flat top-down rectangle, and the warped image is what enters the page state (replacing the manual-crop step from phase 1).
- **Manual override** stays available: if edge-detection fails or returns a bad polygon, the user can tap "Ecken anpassen" and drag the four corners manually before confirming the warp. The phase-1 rectangular crop UI is removed in favour of this four-point UI.
- **Fallback** when `getUserMedia` is denied / unavailable (e.g. older Android): the route falls back to the phase-1 `<input type="file" capture="environment">` flow without warping. The user sees the manual-crop step from phase 1 in that case.

### Out of scope (intentionally — defer to future changes)

- **OCR on the client**. Paperless's OCR pipeline runs server-side and produces higher-quality text than any browser-side Tesseract.js could; no need to duplicate it.
- **Auto-trigger when the document is "stable" in frame**. Apple Notes does this; adding it costs significant timing-heuristic code and the manual shutter is fine for v1/v2.
- **Batch ingestion of N already-shot photos from the camera roll**. The existing `/upload` route handles that path; this change is specifically about the "shoot pages in-app" flow.
- **PDF/A or signed PDFs**. The output is plain PDF 1.7; archival-quality variants are a separate request.
- **Native app via Tauri mobile / Capacitor**. The whole point is that browser APIs are sufficient. Tauri mobile is still pre-1.0 and not on the desktop-app roadmap. If it lands, the SPA code transfers as-is.
- **Live video preview in phase 1**. Phase 1 deliberately uses the OS camera UI to avoid the `getUserMedia` permissions UX (which is a friction point on iOS) and to keep the phase-1 diff small.
- **Cropping individual pages after a full multi-page capture is done**. The user can rotate / delete / reorder in phase 1; cropping is the manual rectangular crop applied at capture time. Re-cropping after capture is a phase-2 nice-to-have if jscanify lands the four-point editor cheaply.
- **Compression presets / "send as B/W to save bandwidth"**. Single quality preset (JPEG 0.85 embedded in PDF) is fine for now; revisit if PDFs balloon past a few MB.

## Capabilities

### New Capabilities

None. This adds a new SPA route + client-side PDF composition; both extend the existing `aktenraum-web` capability rather than introducing a new domain.

### Modified Capabilities

- `aktenraum-web`: gains a `/scan` route that captures images via the device camera, lets the user reorder/rotate/crop/delete pages, composes a multi-page PDF client-side, and uploads it through the existing `POST /api/documents/upload` endpoint. Phase 2 adds auto edge-detection + perspective correction via a lazy-loaded jscanify chunk.

## Impact

- **Code (frontend)**:
  - `apps/web/package.json` — add `pdf-lib` (~340 KB minified, MIT) as a runtime dep. Phase 2 adds `jscanify` (~50 KB JS wrapper) + `opencv.js` (~8 MB; loaded only via `jscanify`'s init).
  - `apps/web/src/routes/Scan.tsx` — new route component with capture, thumbnail grid, reorder/rotate/crop/delete, PDF composition, upload.
  - `apps/web/src/router.tsx` — register `/scan`; add to `Nav.tsx`.
  - `apps/web/src/lib/scan-pdf.ts` — pure helper: `pagesToPdf(pages: ScanPage[]) → Promise<Blob>`. Unit-testable with `pdf-lib` in jsdom.
  - `apps/web/src/lib/scan-state.ts` — Zustand/Jotai or local-state hooks for the page-list (decision in design.md; lean toward `useReducer` because state is scoped to one page).
  - `apps/web/vite.config.ts` — add a manual chunk rule for jscanify (phase 2 only).
  - `apps/web/tests/` — vitest cases for `pagesToPdf` (page count, rotation, crop dimensions); component tests for the reorder UX.
- **Code (backend)**: none. The upload endpoint, dedupe, OCR, auto-tagger pipeline all already handle PDF input.
- **DB / infra / Docker**: none.
- **Docs**:
  - `CLAUDE.md` — new row in "What's implemented vs planned" once shipped; mobile-responsiveness row mentions `/scan` as the in-app capture path.
  - Session note when shipped.
- **Bundle size**:
  - Phase 1 adds ~110 KB gzip (`pdf-lib`) to the main bundle.
  - Phase 2 adds an ~8 MB chunk (OpenCV.js via jscanify) loaded ONLY when the user navigates to `/scan`. The main bundle is unaffected.
- **Browser support**:
  - Phase 1: any browser supporting `<input type="file" accept="image/*" capture="environment">` and `pdf-lib` — iOS Safari 14+, Android Chrome 90+, all desktop evergreen. Falls back to plain file picker on desktop / older browsers (still usable).
  - Phase 2: requires `getUserMedia` over HTTPS (which the Tailscale topology already gives us) and WebAssembly for OpenCV.js. Identical browser baseline; graceful fallback to phase-1 flow if either is unavailable.
- **Security**: no new endpoints or tokens. PDF composition is purely client-side; bytes leave the browser only via the existing authenticated `POST /api/documents/upload`. The Paperless token stays server-side as today.
