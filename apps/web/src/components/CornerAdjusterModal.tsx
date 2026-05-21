import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { XIcon } from "./Icons";
import {
  type Corners,
  type Point,
  type ScanEngine,
  defaultCorners,
  estimateOutputSize,
  getScanEngine,
} from "../lib/scan-engine";

type Props = {
  blob: Blob;
  onCancel: () => void;
  onApply: (warpedBlob: Blob) => void;
};

type CornerKey = keyof Corners;

const CORNER_ORDER: CornerKey[] = [
  "topLeftCorner",
  "topRightCorner",
  "bottomRightCorner",
  "bottomLeftCorner",
];

type Phase =
  | "loading-engine"
  | "loading-image"
  | "detecting"
  | "ready"
  | "warping"
  | "error";

const MAX_OUTPUT_SIDE = 2400;

export function CornerAdjusterModal({ blob, onCancel, onApply }: Props) {
  const [phase, setPhase] = useState<Phase>("loading-engine");
  const [error, setError] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [corners, setCorners] = useState<Corners | null>(null);
  const [displayBox, setDisplayBox] = useState<{
    w: number;
    h: number;
    scale: number;
  } | null>(null);
  const [autoDetected, setAutoDetected] = useState(false);

  const engineRef = useRef<ScanEngine | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragKeyRef = useRef<CornerKey | null>(null);

  // Load the engine + the source image in parallel. The engine pull is
  // the slow path (multi-MB), the image is cheap; we wait for both.
  useEffect(() => {
    let cancelled = false;

    const url = URL.createObjectURL(blob);
    setImgUrl(url);

    const enginePromise = getScanEngine().then((e) => {
      if (cancelled) return null;
      engineRef.current = e;
      return e;
    });

    enginePromise.catch((err: Error) => {
      if (cancelled) return;
      setError(
        `Scan-Modul konnte nicht geladen werden: ${err.message ?? "unbekannt"}`,
      );
      setPhase("error");
    });

    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [blob]);

  // Once the engine is loaded AND the image is decoded, run detection.
  const onImageLoaded = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setImgSize({ w, h });

    const engine = engineRef.current;
    if (!engine) {
      // engine still loading — bump phase so we know the image is ready
      setPhase("loading-engine");
      return;
    }

    setPhase("detecting");
    // defer the heavy OpenCV call by one frame so React paints the
    // "Erkenne Dokument…" message first.
    requestAnimationFrame(() => {
      try {
        const detected = engine.detectCorners(img);
        if (detected) {
          setCorners(detected);
          setAutoDetected(true);
        } else {
          setCorners(defaultCorners(w, h));
          setAutoDetected(false);
        }
        setPhase("ready");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unbekannter Fehler";
        setError(`Kantenerkennung fehlgeschlagen: ${msg}`);
        setPhase("error");
      }
    });
  }, []);

  // If the engine arrives AFTER the image, kick detection then.
  useEffect(() => {
    if (phase !== "loading-engine") return;
    if (!engineRef.current) return;
    if (!imgSize) return;
    setPhase("detecting");
    const engine = engineRef.current;
    const img = imgRef.current;
    if (!img) return;
    requestAnimationFrame(() => {
      try {
        const detected = engine.detectCorners(img);
        if (detected) {
          setCorners(detected);
          setAutoDetected(true);
        } else {
          setCorners(defaultCorners(imgSize.w, imgSize.h));
          setAutoDetected(false);
        }
        setPhase("ready");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unbekannter Fehler";
        setError(`Kantenerkennung fehlgeschlagen: ${msg}`);
        setPhase("error");
      }
    });
  }, [phase, imgSize]);

  // Translate from natural-pixel corner coords to rendered-on-screen px.
  // The image is rendered with `object-contain` inside a flex box; we
  // compute the display rectangle once it's painted and on resize.
  useLayoutEffect(() => {
    if (!imgSize) return;
    const update = () => {
      const img = imgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const scale = rect.width / imgSize.w;
      setDisplayBox({ w: rect.width, h: rect.height, scale });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [imgSize, phase]);

  const setCornerAt = (key: CornerKey, p: Point) => {
    if (!imgSize) return;
    const x = clamp(p.x, 0, imgSize.w);
    const y = clamp(p.y, 0, imgSize.h);
    setCorners((prev) => (prev ? { ...prev, [key]: { x, y } } : prev));
  };

  const onPointerDown = (key: CornerKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragKeyRef.current = key;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const key = dragKeyRef.current;
    if (!key) return;
    if (!imgRef.current || !displayBox) return;
    const rect = imgRef.current.getBoundingClientRect();
    const localX = (e.clientX - rect.left) / displayBox.scale;
    const localY = (e.clientY - rect.top) / displayBox.scale;
    setCornerAt(key, { x: localX, y: localY });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragKeyRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture is best-effort
    }
  };

  const apply = async () => {
    const engine = engineRef.current;
    const img = imgRef.current;
    if (!engine || !img || !corners) return;
    setPhase("warping");
    requestAnimationFrame(async () => {
      try {
        const { width, height } = estimateOutputSize(corners, MAX_OUTPUT_SIDE);
        const canvas = engine.warp(img, corners, width, height);
        const out = await canvasToJpegBlob(canvas, 0.9);
        onApply(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unbekannter Fehler";
        setError(`Korrektur fehlgeschlagen: ${msg}`);
        setPhase("error");
      }
    });
  };

  const skip = () => onCancel();

  const reset = () => {
    if (!imgSize) return;
    setCorners(defaultCorners(imgSize.w, imgSize.h));
    setAutoDetected(false);
  };

  const polygonPath =
    corners && displayBox
      ? CORNER_ORDER.map((k, i) => {
          const p = corners[k];
          const x = p.x * displayBox.scale;
          const y = p.y * displayBox.scale;
          return `${i === 0 ? "M" : "L"}${x},${y}`;
        }).join(" ") + " Z"
      : "";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-canvas"
      role="dialog"
      aria-label="Ecken anpassen"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-ink">Ecken anpassen</span>
          {phase === "ready" && (
            <span className="ml-2 text-xs text-ink-subtle">
              {autoDetected
                ? "Dokument erkannt — ziehe die Ecken bei Bedarf"
                : "Setze die vier Ecken auf das Dokument"}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Abbrechen"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface hover:text-ink"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden p-2 sm:p-4"
      >
        {imgUrl && (
          <div className="relative inline-block max-h-full max-w-full">
            <img
              ref={imgRef}
              src={imgUrl}
              alt="Aufnahme"
              onLoad={onImageLoaded}
              className="block max-h-[calc(100vh-220px)] max-w-full select-none object-contain"
              draggable={false}
            />
            {corners && displayBox && phase === "ready" && (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox={`0 0 ${displayBox.w} ${displayBox.h}`}
                preserveAspectRatio="none"
              >
                <path
                  d={polygonPath}
                  fill="rgba(16, 185, 129, 0.18)"
                  stroke="rgb(16, 185, 129)"
                  strokeWidth={2}
                />
              </svg>
            )}
            {corners &&
              displayBox &&
              phase === "ready" &&
              CORNER_ORDER.map((key) => {
                const p = corners[key];
                const left = p.x * displayBox.scale;
                const top = p.y * displayBox.scale;
                return (
                  <button
                    key={key}
                    type="button"
                    onPointerDown={onPointerDown(key)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    aria-label={`Ecke ${key}`}
                    className="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-emerald-500 bg-white/85 shadow-md active:scale-110 active:bg-emerald-100"
                    style={{
                      left: `${left}px`,
                      top: `${top}px`,
                    }}
                  />
                );
              })}
          </div>
        )}

        {(phase === "loading-engine" ||
          phase === "loading-image" ||
          phase === "detecting" ||
          phase === "warping") && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/70">
            <div className="rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-ink-muted shadow-sm">
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                {phase === "loading-engine" && "Lade Scan-Modul…"}
                {phase === "loading-image" && "Lade Aufnahme…"}
                {phase === "detecting" && "Erkenne Dokumentkanten…"}
                {phase === "warping" && "Wende Perspektivkorrektur an…"}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={phase !== "ready"}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
          >
            Zurücksetzen
          </button>
          <button
            type="button"
            onClick={skip}
            disabled={phase === "warping"}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
          >
            Überspringen
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={phase === "warping"}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-muted hover:bg-canvas disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={phase !== "ready"}
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
          >
            Übernehmen
          </button>
        </div>
      </div>

      {error && phase === "error" && (
        <div className="border-t border-hairline bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={skip}
              className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Ohne Korrektur fortfahren
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("JPEG-Encoding fehlgeschlagen"));
      },
      "image/jpeg",
      quality,
    );
  });
}
