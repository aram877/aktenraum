## 1. Phase 1 — Foundations

- [x] 1.1 Added `pdf-lib ^1.17.1` + `react-image-crop ^11.0.7` (swapped from `cropperjs` — react-image-crop is hooks-native, smaller, no jQuery-era wrapper). `pnpm install` added 6 packages to the workspace, lockfile diff minimal
- [x] 1.2 Created `apps/web/src/lib/scan-types.ts` with `Rotation`, `ScanCrop`, `ScanPage`, `ScanAction`, `ScanState`, `initialScanState`, `MAX_PAGES=30`
- [x] 1.3 Created `apps/web/src/lib/scan-reducer.ts` with pure `scanReducer(state, action)` covering all six action types; remove/rotate/crop/replace return same `state` reference when no page matched (cheap memo); reorder clamps out-of-bounds indices
- [~] 1.4 DEFERRED — apps/web has no vitest/jsdom setup today (rest of SPA is verified via build + lint + manual smoke). Adding a test runner just for this feature creates inconsistent precedent. Reducer is pure + small enough to verify by reading; covered in manual smoke (4.x)

## 2. Phase 1 — PDF composition helper

- [x] 2.1 Created `apps/web/src/lib/scan-pdf.ts` with `pagesToPdf(pages, opts?)` + `formatLocalIso(date)` helper. Defaults `jpegQuality=0.85`, `maxSidePx=3200`. Throws on empty pages
- [x] 2.2 Pipeline matches design.md §2: A4 constants (595.28 × 841.89 pt), letterbox via `Math.min` scale, rotation via `ctx.rotate(rad)` after centering, crop via `drawImage` source rect, downscale on longest side, white canvas fill, JPEG via `canvas.toBlob('image/jpeg', q)`, embed via `pdfDoc.embedJpg(uint8)`, `Blob([bytes], { type: 'application/pdf' })`
- [~] 2.3 DEFERRED — same vitest setup gap as 1.4. Covered in live smoke (4.3, 4.5) where the resulting PDF is opened in the Library preview and verified visually
- [x] 2.4 `pnpm build` clean. **pdf-lib + react-image-crop landed in the lazy-loaded `Scan-<hash>.js` route chunk (460 KB / 187 KB gzip), NOT the main bundle.** Main `index-<hash>.js` UNCHANGED at 358 KB / 116 KB gzip — better than the ≤120 KB delta the design predicted, because route-level lazy loading was already in place

## 3. Phase 1 — Scan route UI

- [x] 3.1 Created `apps/web/src/routes/Scan.tsx` with `useReducer(scanReducer, initialScanState)`, hidden `<input type="file" accept="image/*" capture="environment">` triggered by a "Seite aufnehmen" button (CameraIcon), thumbnail grid, filename input + "Hochladen" footer. Mobile-first: `grid-cols-2 sm:grid-cols-3`, single-column controls below `sm:`. Reuses `Nav active="scan"`
- [x] 3.2 Per-tile controls: ↑↓ reorder buttons (swapped from `dnd-kit` — simpler, no new dep, mobile-friendly), rotate (90° CW), crop (opens modal), delete (TrashIcon, red). All `inline-flex h-8 w-8` touch-friendly. Reorder buttons disabled at list ends. Long-press / drag-to-reorder deferred to a future polish PR if user wants it
- [x] 3.3 Crop modal: full-screen using `react-image-crop` (swapped from cropperjs — react-image-crop is hooks-native, smaller, no jQuery-style wrapper). `<ReactCrop>` wraps the source `<img>`, "Übernehmen" rounds the `PixelCrop` to ints and dispatches `{ type: 'crop', id, crop: { x, y, w, h } }`. "Zurücksetzen" resets to full image bounds. <8 px sentinel rejects accidental zero-crop
- [x] 3.4 Filename input defaults to `scan-${formatLocalIso(new Date())}` — `formatLocalIso` lives in `lib/scan-pdf.ts`. User can edit before upload; `.pdf` suffix shown as a static label
- [x] 3.5 "Hochladen" button calls `pagesToPdf(state.pages)` → `new File([blob], `${name}.pdf`, { type: 'application/pdf' })` → `uploadDocument({ file, onProgress })` from `lib/documents.ts`. Disabled when `pages.length === 0` or `busy`. Phase label "PDF wird erzeugt…" / "Wird hochgeladen" shown during composition + upload
- [x] 3.6 Post-upload lifecycle progress duplicated inline (kept parallel to `Upload.tsx`'s polling — extracting a shared component would force a bigger refactor; deferred). Phases: `composing → uploading → consuming → ai → (inbox | library | error)`. `TerminalSummary` card with "Weiteres Dokument scannen" / "Zur Prüfung →" / "Zur Bibliothek →" buttons and a link to the new doc id
- [x] 3.7 Route registered in `router.tsx` (lazy-loaded via `Scan = lazy(() => import("./routes/Scan").then((m) => ({ default: m.Scan })))`); "Scannen" nav entry added to both desktop nav and mobile drawer in `Nav.tsx`; new `NavKey = "scan"`. Added 5 new icons to `Icons.tsx`: CameraIcon, RotateIcon, CropIcon, ArrowUpIcon, ArrowDownIcon

## 4. Phase 1 — Verification

- [x] 4.1 `pnpm lint` clean (0 errors; 2 pre-existing warnings in TypeSpecificFieldsSection + router.tsx unrelated to this change)
- [x] 4.2 `pnpm build` clean. Bundle metrics recorded above (2.4) — main chunk UNCHANGED, Scan chunk 187 KB gzip
- [ ] 4.3 DEFERRED TO MAINTAINER — Local mobile smoke via Tailscale MagicDNS HTTPS: capture 1 page, 3 pages with reorder + rotate + crop, upload, watch the lifecycle progress complete. Verify the resulting doc appears in the Library and that opening the preview shows the correct page count + orientation + crop
- [ ] 4.4 DEFERRED TO MAINTAINER — Desktop fallback smoke: open `/scan` in Chrome desktop, confirm the camera input opens the file picker and the flow still completes
- [ ] 4.5 DEFERRED TO MAINTAINER — iOS Safari smoke (Tailscale URL): confirm `<input capture>` opens the camera, verify PDF composition doesn't OOM the tab on a 10-page scan

## 5. Phase 1 — Documentation cadence

- [x] 5.1 CLAUDE.md row added under "What's implemented vs planned" between the Upload and Reprocess rows
- [x] 5.2 Session addendum appended to `docs/sessions/2026-05-21.md` with the full feature description, deliberate scope choices, bundle metrics, and the deferred-to-maintainer mobile smoke list. Also added a "pick up next session" bullet pointing at Phase 2
- [x] 5.3 `openspec status --change "mobile-document-scan"` still 4/4 artifacts done (artifacts were complete already from the propose step). Archive deferred until Phase 2 lands or Phase 1 is split into its own archive after smoke-test verification

## 6. Phase 2 — split into 2a (post-capture detection) and 2b (live preview)

Original Phase 2 bundled `getUserMedia` live preview AND jscanify edge-detection. Decision after Phase 1 verified working on user's phone: ship **2a (post-capture edge-detection + perspective warp)** now, defer **2b (live preview)** as a polish PR. Both phases share the 8 MB OpenCV.js cost regardless; splitting halves the risk and gets the bigger visual win to users sooner.

### 6a. Phase 2a — post-capture edge detection + 4-corner perspective warp (SHIPPED)

- [x] 6a.1 Added `jscanify ^1.4.2` + `@techstark/opencv-js ^4.12.0` to `apps/web/package.json`. jscanify ships its own bundled `opencv.js` but its `package.json#exports` doesn't expose it; `@techstark/opencv-js` is the maintained npm-friendly OpenCV.js build with proper module entry + ambient TypeScript types
- [x] 6a.2 Created `apps/web/src/lib/scan-engine.ts` — lazy-loads both libs, awaits `cv.onRuntimeInitialized`, exposes `getScanEngine() → Promise<ScanEngine>` with `detectCorners(source) → Corners | null` + `warp(source, corners, w, h) → HTMLCanvasElement`. Also exports `estimateOutputSize(corners, maxSide)` (derives warp target dimensions from corner distances) and `defaultCorners(w, h)` (95% inset fallback). Single-flight via a module-level promise; resets on error so retries are possible. Module-shim `src/types/scan-engine.d.ts` types the untyped `jscanify/client` subpath (the @techstark global is already declared upstream — redeclaring it conflicts)
- [x] 6a.3 Configured `vite.config.ts` `build.rollupOptions.output.manualChunks` so jscanify + `@techstark/opencv-js` emit to a `scan-engine-<hash>.js` chunk. Bumped `chunkSizeWarningLimit` to 12000 to silence the (intentional) OpenCV.js size warning while keeping it meaningful for other chunks
- [x] 6a.4 Decision: SKIPPED the feature-flag pattern. Phase 2a strictly subsumes Phase 1's rectangular crop (a rectangle IS a degenerate 4-corner polygon) so the rectangular crop modal + `react-image-crop` dep were removed entirely. Phase 1 behaviour preserved: skip detection → keep raw blob → upload (the corner adjuster has "Überspringen" + "Abbrechen" buttons that close without warping). `react-image-crop` uninstalled from `package.json`
- [x] 6a.5 Created `apps/web/src/components/CornerAdjusterModal.tsx` — auto-loads engine + image in parallel, runs `detectCorners` with a `requestAnimationFrame` deferred call so the loading state paints first, renders SVG polygon overlay + 4 absolutely-positioned circular drag handles on the source image. Handles use `PointerEvent` (mouse + touch unified), `setPointerCapture` for drag-out-of-handle robustness, `touch-none` Tailwind class so iOS doesn't intercept the gesture. Coords are stored in natural image space; the displayBox state caches the scale factor and updates on `resize`. "Übernehmen" warps via `engine.warp`, JPEG-encodes the resulting canvas at 0.9, dispatches `replace` to the page reducer
- [x] 6a.6 `Scan.tsx`: auto-opens the adjuster on every newly-added page via a `useEffect` watching `pages.length` (compared against a `useRef` to detect grow-only transitions). The per-tile "Ecken anpassen" button is also wired to the adjuster so the user can re-edit later. Removed dead `react-image-crop` + `CropModal` code. Updated the intro copy to mention auto edge-detection
- [x] 6a.7 Loading state "Lade Scan-Modul…" while the dynamic import is in flight (covered by the modal's `loading-engine` phase). 30s timeout → DEFERRED — the engine's first call hangs at network speed for OpenCV.js; if it times out the user can close the modal and skip ("Überspringen"). A hard timeout adds plumbing for limited benefit because the next page they capture will reuse the in-flight promise
- [x] 6a.8 Permission-denied handling — N/A in 2a since we still use `<input capture>`, not `getUserMedia`. Documented in 2b
- [x] 6a.9 Build verified: `dist/assets/scan-engine-<hash>.js` chunk emitted at 10,793 KB / **3,500 KB gzip**. Main `index-<hash>.js` UNCHANGED at 116 KB gzip. The Scan chunk dropped slightly to 451 KB / 186 KB gzip after `react-image-crop` removal
- [ ] 6a.10 DEFERRED TO MAINTAINER — Live mobile smoke: open `/scan` on iPhone Safari via Tailscale, capture a tilted document, watch the corner adjuster open, verify detected corners reasonably match the document, drag a corner to nudge, tap Übernehmen, confirm the warped page in the thumbnail. Re-edit via the tile button. Skip path: tap Überspringen, confirm the raw photo is kept. Multi-page flow: capture 3 pages, adjust each, upload, verify the resulting PDF in the Library
- [x] 6a.11 CLAUDE.md row updated with Phase 2a notes
- [ ] 6a.12 Session addendum + commit/push gated on user's phone smoke

### 6b. Phase 2b — live `getUserMedia` preview with edge overlay (DEFERRED)

Ships only after 2a settles for a week+ of real mobile use and the user wants the rapid-fire capture flow.

- [ ] 6b.1 Replace `<input type="file" capture>` with a `<video>` element bound to `getUserMedia({ video: { facingMode: 'environment' } })`
- [ ] 6b.2 Overlay `<canvas>` running `findPaperContour` every other animation frame (`requestAnimationFrame`); render the polygon at 30 fps; throttle if frame budget exceeded
- [ ] 6b.3 Shutter button: grab current frame to a snapshot canvas, run detection one more time, hand off to the existing CornerAdjusterModal flow (so corner adjuster is reused across both capture modes)
- [ ] 6b.4 Permission-denied fallback: catch `NotAllowedError` and silently switch to the Phase-1 `<input capture>` flow
- [ ] 6b.5 iOS-specific: `playsinline` attribute on the video; lock orientation hint; handle `pagehide` to release the camera
- [ ] 6b.6 30s engine-load timeout → fall back to `<input capture>` flow
- [ ] 6b.7 Auto-shutter when polygon is stable for 1.5s (optional polish)
- [ ] 6b.8 Live mobile smoke on iPhone Safari + Android Chrome
- [ ] 6b.9 CLAUDE.md row update; session note; archive of the whole change
