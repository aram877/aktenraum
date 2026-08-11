## ADDED Requirements

### Requirement: SPA exposes a `/scan` route that captures document pages and composes them into a PDF client-side

The SPA SHALL register a route at `/scan` (rendered in the Nav next to "Hochladen") that lets a user capture one or more document pages via the device camera, manage the captured pages, compose them into a single PDF in the browser, and upload that PDF through the existing `POST /api/documents/upload` endpoint.

Phase 1 SHALL use `<input type="file" accept="image/*" capture="environment">` to invoke the OS camera UI. Phase 2 SHALL replace that with a `getUserMedia`-based live preview when the browser supports it (HTTPS + `navigator.mediaDevices`); when `getUserMedia` is unavailable or denied, the route MUST silently fall back to the phase-1 `<input>` flow without errors visible to the user.

The route SHALL NOT require any backend changes — the PDF MUST leave the browser as a multipart-form `application/pdf` blob handed to the existing upload mutation.

#### Scenario: Mobile user captures a single page and uploads
- **WHEN** the user navigates to `/scan` on a phone, taps the "Seite hinzufügen" button, takes a photo via the OS camera, and taps "Hochladen"
- **THEN** the SPA composes a single-page PDF in the browser, POSTs it to `/api/documents/upload` as `multipart/form-data`, and renders the same task → doc → lifecycle progress UI that `/upload` shows

#### Scenario: Multi-page document
- **WHEN** the user captures three pages in sequence, reorders them via drag, deletes the second, rotates the third 90°, then taps "Hochladen"
- **THEN** the resulting PDF has two pages in the user's final order, each rotated as the user specified, and uploads as a single document

#### Scenario: Desktop fallback to file picker
- **WHEN** a desktop user opens `/scan`
- **THEN** the "Seite hinzufügen" control opens the OS file picker (no camera) and any selected image is added to the page list; the rest of the flow (reorder, rotate, crop, compose, upload) behaves identically to mobile

### Requirement: Captured pages can be reordered, rotated, cropped, and deleted before PDF composition

The `/scan` route SHALL render a thumbnail grid of all captured pages and SHALL expose four user actions per page:

- **Reorder** — drag-to-sort or arrow buttons to move a page up/down in the sequence
- **Rotate** — 90° clockwise step (cycles 0 → 90 → 180 → 270 → 0)
- **Crop** — open a crop UI; in phase 1 a rectangular crop, in phase 2 a four-corner perspective-correction UI driven by `jscanify`. The crop UI MUST allow the user to confirm or cancel the change.
- **Delete** — remove the page from the sequence; the action MUST be reversible only by re-capturing (no undo stack required for v1).

The captured page list MUST be retained in memory for the duration of the `/scan` session. Navigating away from `/scan` and returning resets the page list (no draft persistence is required for v1).

#### Scenario: Reorder updates the PDF order
- **WHEN** the user captures pages A, B, C and drags C to position 1
- **THEN** the composed PDF emits pages in the order C, A, B

#### Scenario: Rotate persists into the PDF
- **WHEN** the user rotates page A by 90° and uploads
- **THEN** the corresponding PDF page is rendered with the rotation applied (not the raw camera orientation)

#### Scenario: Delete removes the page from the sequence and the PDF
- **WHEN** the user deletes the second of three captured pages and uploads
- **THEN** the composed PDF has exactly two pages, in the order of the remaining pages

#### Scenario: Crop applies to the embedded image
- **WHEN** the user crops a page to a sub-region (phase 1 rectangular crop) and confirms
- **THEN** the page's PDF embed is the cropped region only; the original camera-frame margins are not included

### Requirement: PDF composition is client-side and uploads through the existing upload endpoint

The SPA SHALL compose the PDF entirely in the browser using `pdf-lib`. The composition pipeline MUST:

1. For each captured page, decode the source blob and apply rotation + crop into an off-screen `<canvas>`.
2. Downscale the canvas if its longest side exceeds 3200 px (to bound output file size).
3. Encode the canvas as JPEG at quality 0.85.
4. Embed the JPEG into a new `PDFDocument` page sized A4 portrait (595 × 842 PDF user units), letterboxed to preserve the source aspect ratio.
5. After all pages are embedded, call `pdfDoc.save()` and wrap the bytes in a `Blob` of MIME type `application/pdf`.

The resulting blob MUST be wrapped in a `File` named `<filename>.pdf` (where `<filename>` is the user-editable input, defaulting to `scan-YYYY-MM-DD-HHmmss`) and uploaded via the SAME `useDocumentUpload` mutation that the `/upload` route already uses — the scan route MUST NOT add a new server endpoint, a new authentication path, or a new polling mechanism. Post-upload polling (task → doc → lifecycle) MUST be the existing helper reused unchanged.

#### Scenario: Composed PDF posts to the existing upload endpoint
- **WHEN** the user taps "Hochladen" with N pages captured
- **THEN** the SPA POSTs a single `multipart/form-data` request to `/api/documents/upload` with one `files` field whose name is `<user-filename>.pdf` and whose content-type is `application/pdf`

#### Scenario: Filename defaults to ISO timestamp
- **WHEN** the user opens `/scan` and does not edit the filename input
- **THEN** the uploaded filename is `scan-YYYY-MM-DD-HHmmss.pdf` matching the user's local time at upload

#### Scenario: Upload reuses the lifecycle progress UI
- **WHEN** the upload returns a Paperless task UUID
- **THEN** the SPA polls `/task/{uuid}` every 1.5s and `/{doc_id}/status` every 3s with the same 120s ceiling, and renders the same "Bereit → Wird hochgeladen → Paperless verarbeitet… → KI klassifiziert… → ✓ in der Inbox / ✓ in der Bibliothek / ✗ Fehler" states that `/upload` does

### Requirement: Phase 2 lazy-loads jscanify for auto edge-detection without inflating the main bundle

When phase 2 is enabled, the SPA SHALL load the `jscanify` library (and its OpenCV.js dependency) via a dynamic `import()` that resolves only when the user navigates to `/scan`. The Vite build configuration MUST emit jscanify and OpenCV.js into a separate chunk so the main bundle is unaffected.

While the scan engine is loading, the route MUST render a "Lade Scan-Modul…" loading state and MUST fall back to the phase-1 `<input type="file" capture>` flow if the dynamic import fails or times out (30 s).

When jscanify is loaded and `getUserMedia` is granted, the route SHALL render a live video preview with a green overlay polygon marking the detected document edges. Tapping the shutter SHALL grab the current frame, run `jscanify.extractPaper` to produce a flat top-down rectangle, and add that warped image as a new page. The user MUST be able to override a bad detection via a four-corner manual editor.

#### Scenario: Main bundle stays small
- **WHEN** the production build is run with phase 2 enabled
- **THEN** the main `index-<hash>.js` chunk MUST NOT contain jscanify or OpenCV.js code, and a separate `scan-engine-<hash>.js` chunk MUST exist that contains both

#### Scenario: Engine loads only on /scan visit
- **WHEN** a user visits any route other than `/scan`
- **THEN** the `scan-engine-<hash>.js` chunk MUST NOT be fetched

#### Scenario: getUserMedia denied falls back to OS camera
- **WHEN** the user denies the camera permission on the `/scan` route
- **THEN** the route silently switches to the phase-1 `<input type="file" capture="environment">` flow and the user can still complete a scan

#### Scenario: Manual corner override on bad detection
- **WHEN** jscanify's auto-detection produces a polygon that misses the document and the user taps "Ecken anpassen"
- **THEN** the route renders a four-corner editor on top of the captured frame; the user drags the corners to the correct positions and taps "Übernehmen", and the page is added with the manually-corrected warp
