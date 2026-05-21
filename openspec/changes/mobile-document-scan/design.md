## Context

aktenraum's web upload flow today is `<input type="file" multiple>` plus a TanStack-Query mutation that POSTs each file individually to `/api/documents/upload`. From a phone that's already the long way around: open Safari → tap Upload → app-switch to the OS camera → take photo → return to Safari → wait for the camera roll to refresh → pick the file. Multi-page documents make it worse because each capture lands as its own image, and Paperless treats them as separate documents.

Every commodity scanner app (Apple Notes, Genius Scan, Adobe Scan) collapses the flow to: open scanner → frame → snap → next page → review → done → one PDF. The reason aktenraum doesn't ship that today is purely build order — the AI / inbox / RAG path took priority. With mobile responsiveness (commit `2e154c1`) and Tailscale HTTPS ([ADR-005](../../../docs/adr/005-test-phase-access-via-tailscale.md)) both live, the missing piece is the in-app capture flow.

Grounding for the technical decisions below:

- **Existing upload pipeline**: `apps/web/src/routes/Upload.tsx` uses `useDocumentUpload` (`apps/web/src/lib/upload.ts`) which POSTs to `/api/documents/upload`. The endpoint accepts multipart `files`; per-file response carries `task_id`. The post-upload poller (`/task/{uuid}` → `/{doc_id}/status`) renders the lifecycle progress. **None of this needs to change** — the scan flow produces a single `Blob` of type `application/pdf` and hands it to the same `uploadFiles` helper.
- **Existing PDF library surface**: no PDF generation lib in the SPA today. We're adding `pdf-lib` as a runtime dep. Alternatives: `jspdf` (older, less ergonomic, larger), `pdfkit` (node-oriented, requires bundling shims), `pdf-lib` (MIT, ~340 KB minified, ~110 KB gzip, modern API, jsdom-friendly so we can unit-test composition).
- **Browser camera APIs** worth distinguishing:
  - `<input type="file" accept="image/*" capture="environment">` — invokes the **OS camera UI**. Returns a still image File. Universal support, zero permissions UX inside our page, no live preview / edge-detection possible.
  - `getUserMedia({ video: { facingMode: 'environment' } })` — live video stream we render and snap from. Allows real-time overlays (edge-detection) and auto-trigger. Requires HTTPS (Tailscale gives us that) and a permission prompt. iOS Safari adds friction on the prompt UX.
- **Edge-detection libs** considered: `jscanify` (MIT, OpenCV.js-based, ~50 KB JS + ~8 MB WASM, four-corner warp + perspective correction in ~30 LOC), `cropperjs` (rectangular crop only — not perspective correction; doesn't solve the tilted-page problem), Scanbot SDK / Dynamsoft (commercial, contradicts self-hosted/open-source posture). `jscanify` is the right pick.
- **Bundle constraints**: the main SPA bundle today is ~600 KB gzip. `pdf-lib` adding ~110 KB gzip is acceptable for a feature this central to mobile UX. OpenCV.js at ~8 MB is NOT acceptable for the main bundle — it must be a route-split chunk loaded only when the user navigates to `/scan`.

## Goals / Non-Goals

**Goals:**
- A `/scan` route that lets a mobile user capture multi-page documents end-to-end inside the browser and produce one PDF without leaving Safari/Chrome.
- Phase 1 ships in a small, reviewable diff: capture → thumbnail grid → reorder/rotate/crop/delete → PDF → upload. Working scanner with mediocre but-not-bad UX.
- Phase 2 lifts the UX to "good enough you'd actually use it daily" via auto edge-detection + perspective correction.
- Phase 2 must not regress phase-1 reachability: when `getUserMedia` or OpenCV.js isn't available, the route silently falls back to the phase-1 flow.
- Zero backend changes. Whatever leaves the browser is just a PDF in a `POST /api/documents/upload` body, identical to a PDF that arrived via email ingestion or the watched folder.
- The scan endpoint reuses the existing post-upload polling so the "Paperless processing → KI klassifiziert → ✓ in der Inbox" experience is consistent with `/upload`.

**Non-Goals:**
- Replacing `/upload` for the file-pick path. The two coexist.
- OCR on the client. Paperless OCR is the source of truth.
- Auto-trigger on document-stable detection. Manual shutter is fine for v1+v2.
- PDF/A archival format, signed PDFs, encryption.
- Wrapping the SPA in Tauri mobile or Capacitor to get a "real" app. Browser APIs are the deliverable.
- Offline-first / draft persistence across navigations. If the user backs out of `/scan` mid-capture, the page state is lost. Acceptable for v1; revisit only if we hear it bite.
- Live overlay rendering in phase 1. Phase 1 uses the OS camera UI for capture.

## Decisions

### 1. Phase 1 uses `<input type="file" capture="environment">`; phase 2 switches to `getUserMedia`

Phase 1 deliberately picks the simpler API:

```html
<input type="file" accept="image/*" capture="environment" />
```

- **Pros**: universal browser support, no permission prompt inside our page (the OS handles it), no live-preview rendering code, no `getUserMedia` constraints to negotiate. Ships fast.
- **Cons**: no edge-detection possible (no live frame access), no auto-snap, the OS camera UI takes over the screen.

Phase 2 swaps to `getUserMedia` because edge-detection needs live frames:

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
});
```

A `<video>` tag plays the stream; an overlay `<canvas>` renders the detected document polygon at 30 fps via `requestAnimationFrame` + `jscanify.findPaperContour`. Tapping the shutter grabs the current frame into a `<canvas>`, runs `jscanify.extractPaper` to warp it to a flat rectangle, and the warped blob enters the page state.

Alternatives considered:
- **`getUserMedia` for both phases.** Rejected — adds permission-prompt UX work and live-preview rendering to phase 1 for no immediate value (no edge-detection without jscanify). Defer.
- **`<input type="file" capture>` for both phases.** Rejected — the whole point of phase 2 is the edge-detection win, which is impossible without live frame access.
- **Use the `ImageCapture` API.** Promising but Safari support is still flagged off as of 2025-Q4; would force `getUserMedia` as a fallback anyway. Skip until Safari catches up.

### 2. PDF composition via `pdf-lib`, embedding JPEG-encoded canvases

For each page in the user's list:

1. Decode the source blob (`Image` element + `URL.createObjectURL`).
2. Apply rotation (0/90/180/270) and crop (rectangular in phase 1, perspective-warped in phase 2) into a destination `<canvas>` whose dimensions match the chosen target page size.
3. `canvas.toBlob('image/jpeg', 0.85)` → `Uint8Array` via `await blob.arrayBuffer()`.
4. `await pdfDoc.embedJpg(uint8)` → `PDFImage`.
5. `page = pdfDoc.addPage([A4Width, A4Height])`; `page.drawImage(image, { x, y, width, height })` with letterboxing to preserve aspect ratio.
6. After all pages embedded: `await pdfDoc.save()` → `Uint8Array` → `new Blob([uint8], { type: 'application/pdf' })`.

Page size policy: target A4 (595×842 PDF user units = 210×297 mm). Letterbox to preserve aspect — a photographed page is rarely exactly A4-ratio, and stretching distorts text. Acceptable trade-off: small white margins on non-A4-ratio sources.

JPEG quality 0.85 is the standard sweet spot — visually lossless for document text at typical phone-camera resolutions, file sizes ~150–300 KB per page on a modern phone. We're not optimising for archival; we're optimising for "looks fine in the inbox preview".

Alternatives considered:
- **Embed PNG instead of JPEG.** PNG would be 5–10x larger for text-on-paper photos. Rejected; the user is uploading photographs of pages, not screenshots.
- **One image per PDF page with native page size matching the image.** Tempting (no letterbox) but yields a PDF with N different page sizes, which looks janky in any PDF viewer's two-page mode and surprises tools that expect uniform pages. Skip.
- **Compose server-side from images.** Discussed in the proposal Why; the user's preference (and the design constraint) is "the upload is already a PDF when it leaves the browser" so the existing pipeline doesn't need a parallel image-to-PDF branch.

### 3. Page state: `useReducer`, not Zustand

The page-list state is scoped to a single route component and lives for the duration of the user's scan session. It has well-defined transitions (add / remove / reorder / rotate / crop / replace-blob) that map naturally to a discriminated-union action type.

```ts
type ScanPage = { id: string; blob: Blob; rotation: 0|90|180|270; crop: { x:number; y:number; w:number; h:number } | null };
type Action =
  | { type: 'add'; blob: Blob }
  | { type: 'remove'; id: string }
  | { type: 'rotate'; id: string }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'crop'; id: string; crop: ScanPage['crop'] }
  | { type: 'replace'; id: string; blob: Blob };
```

A `useReducer` is enough; Zustand / Jotai would be overkill. No other component reads or writes this state.

Alternatives considered:
- **Jotai atoms** (used elsewhere in the SPA for global state). Rejected — `/scan` state is local; pulling it into a global store would invite leak-on-navigation bugs.
- **Refs + setState** of an array. Less ergonomic for the reorder/crop transitions; reducers handle this cleanly.

### 4. jscanify is dynamic-imported and route-split

```ts
// inside the /scan route
const [scanner, setScanner] = useState<JscanifyApi | null>(null);
useEffect(() => {
  let cancelled = false;
  void import('@/lib/scan-engine').then((m) => {
    if (!cancelled) m.init().then(setScanner);
  });
  return () => { cancelled = true; };
}, []);
```

`apps/web/src/lib/scan-engine.ts` is a thin wrapper that lazy-imports `jscanify` AND awaits the OpenCV.js runtime ready event before resolving. Vite is configured (via `build.rollupOptions.output.manualChunks`) to emit jscanify + OpenCV into a separate chunk named `scan-engine-<hash>.js`. The main bundle is `import()`-ing this on demand, so the chunk is only fetched when the user navigates to `/scan` — and only on phase-2 deployments where jscanify is wired in.

Cache: the OpenCV.js wasm blob is ~8 MB but cacheable forever (immutable hash in the URL). Subsequent visits to `/scan` pay only the WebAssembly instantiation cost (~200 ms on a recent iPhone, ~500 ms on a mid-range Android).

Alternatives considered:
- **Bundle jscanify into the main chunk.** No — 8 MB main-bundle bloat per visit is unacceptable.
- **Host OpenCV.js on a CDN and load via `<script src>`.** Rejected — adds a third-party dependency at runtime, breaks the "self-hosted" posture, and the chunk-split approach gives us the same lazy-load behaviour without leaving our own origin.

### 5. Manual crop (phase 1) is rectangular; phase 2 replaces it with four-corner perspective

Phase 1 manual crop is a simple two-thumb rectangular crop overlay on the captured image. `CropperJS` (MIT, ~30 KB) is the standard pick for this; phase 1 imports it directly into the main `/scan` chunk (it's small enough). Output is `{ x, y, w, h }` in image-pixel coordinates.

Phase 2 replaces the rectangular crop with a four-corner draggable polygon (jscanify exposes the detected corners; the user can drag any of them to correct a bad detection). The reducer's `crop` action becomes a four-point polygon in phase 2; phase 1's `{ x, y, w, h }` shape is intentionally a subset (a rectangular crop IS a degenerate four-corner polygon), so the migration is field rename rather than a wholesale state rewrite.

### 6. Upload path: reuse `useDocumentUpload`, not a new mutation

`apps/web/src/lib/upload.ts` exports `useDocumentUpload`, which accepts `File[]` and POSTs to `/api/documents/upload`. The scan route composes the PDF into a `Blob`, wraps it in a `File` with the user-chosen filename, and calls the same hook. Post-upload polling, error handling, query-invalidation are all reused.

The only subtle bit: a `Blob` is not a `File`, but `File extends Blob` and `new File([blob], filename, { type: 'application/pdf' })` is the standard one-liner. iOS Safari < 14 lacks the `File` constructor but our minimum target is iOS 14+ anyway.

### 7. Filename default: `scan-YYYY-MM-DD-HHmmss.pdf`

ISO-style date in the filename so Paperless's title-extractor and the user's mental sorting both work. The user can edit it in a text input before tapping Upload.

### 8. Phase boundary is a feature flag at the route-component level

Not a runtime flag — a code-level boolean (`const PHASE_2 = false;` at the top of `Scan.tsx`) that gates the `getUserMedia` / jscanify branch. Phase 1 ships with `PHASE_2 = false`; phase 2 PR flips it to `true` and removes the obsolete branches in the same commit. This keeps `/opsx:apply` review steps narrow and makes the phase rollback a one-line revert.

Alternatives considered:
- **Two separate routes (`/scan` and `/scan-v2`).** Rejected — confusing for users, more nav surface, harder to retire phase 1.
- **GrowthBook / runtime flag.** No runtime-flag infra in this repo and not worth adding for a binary phase boundary.

## Risks / Trade-offs

- **[iOS Safari throttles canvas operations on memory-pressured devices]** → Mitigation: bound the page count to 30 in the UI (configurable, generous for documents); show a warning at 20+. PDF generation on an iPhone 12 with 20 A4 pages at JPEG-0.85 takes ~3 s and ~25 MB peak memory in our prototype.
- **[`<input type="file" capture>` on Android sometimes returns full-resolution images (12 MP+)]** → JPEG embed + the 0.85 quality keep this manageable, but a 12-page scan from a recent Pixel could yield a 4 MB PDF. Mitigation: downscale to 2400×3200 max via canvas before embedding (loses no perceptible detail for paper documents).
- **[`getUserMedia` permission denial in phase 2 breaks the live-preview flow]** → Mitigation: catch the `NotAllowedError` and fall back to the phase-1 `<input type="file" capture>` path silently. Detect on mount via `permissions.query({ name: 'camera' })` where supported.
- **[OpenCV.js wasm fails to load on poor connectivity]** → Mitigation: timeout the dynamic import after 30 s and fall back to phase-1 flow. The user can manually retry from a "Lade Scan-Modul…" loading state.
- **[Edge-detection misfires on textured backgrounds (wood grain, patterned tablecloth)]** → Mitigation: the manual-crop / corner-drag UI is always reachable; the auto-detect is "best effort, override if needed". jscanify's `findPaperContour` returns null when no good contour is found — we render the manual UI in that case.
- **[PDF file size for a high-page scan]** → A 10-page A4 scan at JPEG-0.85 lands ~2 MB on a recent phone. Inside nginx's existing `client_max_body_size 500m` and the per-file 25 MB API limit. No additional throttling needed.
- **[Bundle growth of pdf-lib in the main chunk]** → ~110 KB gzip is the cost of admission. Acceptable. If we ever want to be more aggressive, pdf-lib supports tree-shaken imports (`import { PDFDocument } from 'pdf-lib/dist/...`) but the default import is fine for this use case.
- **[Browser tab killed by OS mid-scan loses state]** → Acceptable for v1. No persistence. Pages are session-scoped.

## Migration Plan

1. **Phase 1 PR**: add `pdf-lib` + `cropperjs`, scaffold `/scan` route + reducer + `pagesToPdf` helper + thumbnail grid + manual rectangular crop + filename input + upload. Unit-test `pagesToPdf` (page count, A4 dimensions, rotation/crop application). Component-test the reducer transitions. Manual smoke on iPhone Safari + Android Chrome via the Tailscale HTTPS host. CLAUDE.md + session note.
2. **Phase 2 PR** (separate, ships only after phase 1 settles for a week+ of real-use feedback): add `jscanify` + OpenCV.js, wire `getUserMedia` capture, replace the rectangular crop UI with the four-corner perspective editor, manual-chunk-split jscanify in `vite.config.ts`, add the OpenCV-load loading state and fallback. CLAUDE.md row updated to reflect auto edge-detection.
3. **Rollback** for phase 1: plain `git revert`; no DB / API state to undo.
4. **Rollback** for phase 2: flip `PHASE_2 = false` and revert the same commit's nav-label changes if any. Phase 1 keeps working because phase 2 is strictly additive at the route level.

## Open Questions

- **Default page size: A4 portrait, or auto-detect from image aspect?** Lean A4 portrait — every realistic document target is A4 or US Letter and A4 is the German default. If the user uploads a receipt that's much taller than A4, the JPEG embed scales to fit with letterboxing; the result is fine. Revisit if a real use case demands variable page sizing.
- **Where does `/scan` go in Nav order?** Lean: position it directly after "Hochladen" with a camera icon. Below `md:` it stays visible in the drawer; on desktop it shows but the `<input>` element falls back to a file picker (which is the right behaviour: the desktop user doesn't have a "camera" in the same sense).
- **Should phase 1 include reorder (drag-to-sort)?** Lean yes — sortable touch UX is a 30-line dnd-kit import and the reorder action is the #1 thing users do post-capture. Decide in implementation; defer to a follow-up only if dnd-kit complicates the phase-1 diff.
- **JPEG quality 0.85 fixed, or expose a slider?** Lean fixed for v1. Add a setting only if real-use yields complaints about file size or fidelity.
- **OCR-readable PDF (text layer) vs image-only PDF?** Image-only — Paperless's OCR pipeline regenerates the text layer server-side from the image bytes, so a client-side text layer would be wasted work AND would risk lower-quality text than Paperless's tesseract output. Skip.
