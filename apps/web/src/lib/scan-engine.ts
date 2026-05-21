// Lazy-loaded document-scan engine: OpenCV.js for the WASM math, jscanify
// for the contour-finding and perspective-warp wrappers. Both are heavy
// (~10 MB combined) and live in a Vite manualChunk named "scan-engine" so
// they're only fetched when /scan dynamic-imports this module.
//
// Module shape on the consumer side:
//   const engine = await getScanEngine();
//   const corners = engine.detectCorners(canvas) ?? null;
//   const warped = engine.warp(canvas, corners, w, h);
//
// We deliberately don't try to type OpenCV.js. The package ships rudimentary
// `.d.ts` files but they're widely-acknowledged incomplete; treating cv as
// any at the boundary is the same trade-off jscanify itself makes.

export type Point = { x: number; y: number };

export type Corners = {
  topLeftCorner: Point;
  topRightCorner: Point;
  bottomRightCorner: Point;
  bottomLeftCorner: Point;
};

export type ScanEngine = {
  detectCorners(source: HTMLImageElement | HTMLCanvasElement): Corners | null;
  warp(
    source: HTMLImageElement | HTMLCanvasElement,
    corners: Corners,
    resultWidth: number,
    resultHeight: number,
  ): HTMLCanvasElement;
};

let enginePromise: Promise<ScanEngine> | null = null;

export function getScanEngine(): Promise<ScanEngine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((err) => {
      // Reset so a retry can try again from scratch.
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

async function loadEngine(): Promise<ScanEngine> {
  // @techstark/opencv-js attaches OpenCV to globalThis.cv as a side effect.
  // The WASM runtime initialises asynchronously after the JS evaluates, so
  // we wait on cv.onRuntimeInitialized before exposing any methods.
  await import("@techstark/opencv-js");
  await waitForCvReady();

  // jscanify's client entry expects globalThis.cv to be present. We import
  // the client subpath explicitly — the package's default export is a
  // Node-side build that depends on `canvas` + `jsdom`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("jscanify/client")) as any;
  const Ctor = mod.default ?? mod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scanner: any = new Ctor();

  return {
    detectCorners(source) {
      const cv = globalThis.cv;
      const src = cv.imread(source);
      try {
        const contour = scanner.findPaperContour(src);
        if (!contour) return null;
        const corners = scanner.getCornerPoints(contour) as Corners | undefined;
        if (!corners) return null;
        if (!isValidCorners(corners)) return null;
        return corners;
      } finally {
        src.delete();
      }
    },
    warp(source, corners, resultWidth, resultHeight) {
      const out = scanner.extractPaper(
        source,
        resultWidth,
        resultHeight,
        corners,
      );
      return out as HTMLCanvasElement;
    },
  };
}

function waitForCvReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cv = globalThis.cv;
    if (typeof cv === "undefined") {
      reject(new Error("OpenCV.js wurde nicht geladen"));
      return;
    }
    // Module already ready (e.g. HMR re-import after first load).
    if (typeof cv.Mat === "function") {
      resolve();
      return;
    }
    cv.onRuntimeInitialized = () => resolve();
  });
}

function isValidCorners(c: Corners): boolean {
  return (
    c.topLeftCorner !== undefined &&
    c.topRightCorner !== undefined &&
    c.bottomRightCorner !== undefined &&
    c.bottomLeftCorner !== undefined &&
    typeof c.topLeftCorner.x === "number" &&
    typeof c.topRightCorner.x === "number" &&
    typeof c.bottomRightCorner.x === "number" &&
    typeof c.bottomLeftCorner.x === "number"
  );
}

// Derive target dimensions from the detected polygon so the warp preserves
// the document's real aspect ratio (height comes from the average of the
// two vertical edges, width from the two horizontal edges). Bound to a max
// dimension so we don't blow memory on a multi-MP source.
export function estimateOutputSize(
  corners: Corners,
  maxSide: number,
): { width: number; height: number } {
  const tl = corners.topLeftCorner;
  const tr = corners.topRightCorner;
  const br = corners.bottomRightCorner;
  const bl = corners.bottomLeftCorner;

  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  let width = Math.round((topW + bottomW) / 2);
  let height = Math.round((leftH + rightH) / 2);

  if (width < 1) width = 1;
  if (height < 1) height = 1;

  const longest = Math.max(width, height);
  if (longest > maxSide) {
    const scale = maxSide / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  return { width, height };
}

// Default polygon when detection fails or the source has no detectable
// paper edges: a generous rectangle covering ~90% of the image so the user
// only has to nudge the corners onto the actual document.
export function defaultCorners(width: number, height: number): Corners {
  const inset = 0.05;
  const x1 = Math.round(width * inset);
  const y1 = Math.round(height * inset);
  const x2 = Math.round(width * (1 - inset));
  const y2 = Math.round(height * (1 - inset));
  return {
    topLeftCorner: { x: x1, y: y1 },
    topRightCorner: { x: x2, y: y1 },
    bottomRightCorner: { x: x2, y: y2 },
    bottomLeftCorner: { x: x1, y: y2 },
  };
}
