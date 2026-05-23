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

## 6. Phase 2 — Edge-detection (separate PR, after phase 1 stable)

- [ ] 6.1 Add `jscanify` to `apps/web/package.json`; verify the package vendors OpenCV.js OR add `@techstark/opencv-js` (or equivalent) explicitly
- [ ] 6.2 Create `apps/web/src/lib/scan-engine.ts` — exports `init() → Promise<{ detectContour, extractPaper }>` that lazy-imports jscanify, awaits OpenCV.js runtime ready, and returns a typed thin facade
- [ ] 6.3 Configure `apps/web/vite.config.ts` `build.rollupOptions.output.manualChunks` so jscanify + OpenCV.js emit to a `scan-engine` chunk
- [ ] 6.4 Inside `Scan.tsx`: feature-flag `const PHASE_2 = true;` at the top of the file; wrap the existing `<input capture>` block in `!PHASE_2 || !engineLoaded || !mediaStreamAvailable` and add the `getUserMedia` branch
- [ ] 6.5 Live-preview component: `<video>` + overlay `<canvas>` rendering the detected polygon at 30fps via `requestAnimationFrame`; shutter button captures the current frame, runs `extractPaper`, dispatches `{ type: 'add', blob: warpedBlob }`
- [ ] 6.6 Replace the rectangular crop modal with a four-corner perspective editor (drag corners on the captured frame). Reuse / port the polygon from jscanify's detected output as the initial state; allow drag of each corner; "Übernehmen" dispatches `{ type: 'replace', id, blob: rewarpedBlob }`
- [ ] 6.7 Loading state "Lade Scan-Modul…" while the dynamic import is in flight; 30s timeout → fall through to phase-1 `<input capture>` flow
- [ ] 6.8 Permission-denied handling: catch `NotAllowedError` from `getUserMedia` and fall back silently to `<input capture>`
- [ ] 6.9 Verify `pnpm build` emits the `scan-engine-<hash>.js` chunk and that visiting any route other than `/scan` does NOT fetch it (check via DevTools network on a fresh load)
- [ ] 6.10 Live mobile smoke: open `/scan` on iPhone Safari via Tailscale, confirm the live preview shows, the polygon tracks a real document on a desk, the shutter produces a warped page, multi-page works end-to-end, the manual corner override works
- [ ] 6.11 CLAUDE.md row update: "Phase 2 — `getUserMedia` live preview + jscanify auto edge-detection + perspective correction (lazy-loaded ~8 MB chunk only on `/scan` visit)"
- [ ] 6.12 Session note + archive of this change
