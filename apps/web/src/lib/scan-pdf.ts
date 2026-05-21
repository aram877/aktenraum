import { PDFDocument } from "pdf-lib";

import type { Rotation, ScanCrop, ScanPage } from "./scan-types";

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

export type PagesToPdfOpts = {
  jpegQuality?: number;
  maxSidePx?: number;
};

export async function pagesToPdf(
  pages: ScanPage[],
  opts: PagesToPdfOpts = {},
): Promise<Blob> {
  if (pages.length === 0) {
    throw new Error("Keine Seiten zum Speichern vorhanden");
  }

  const jpegQuality = opts.jpegQuality ?? 0.85;
  const maxSidePx = opts.maxSidePx ?? 3200;

  const pdfDoc = await PDFDocument.create();

  for (const page of pages) {
    const jpegBytes = await renderPageToJpeg(page, jpegQuality, maxSidePx);
    const image = await pdfDoc.embedJpg(jpegBytes);
    const pdfPage = pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);

    const { width: iw, height: ih } = image.scale(1);
    const scale = Math.min(A4_WIDTH_PT / iw, A4_HEIGHT_PT / ih);
    const drawW = iw * scale;
    const drawH = ih * scale;
    const x = (A4_WIDTH_PT - drawW) / 2;
    const y = (A4_HEIGHT_PT - drawH) / 2;

    pdfPage.drawImage(image, { x, y, width: drawW, height: drawH });
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: "application/pdf" });
}

async function renderPageToJpeg(
  page: ScanPage,
  quality: number,
  maxSide: number,
): Promise<Uint8Array> {
  const img = await decodeBlob(page.blob);
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;

  const crop: ScanCrop = page.crop ?? {
    x: 0,
    y: 0,
    w: sourceW,
    h: sourceH,
  };

  const rotated = rotateDimensions(crop.w, crop.h, page.rotation);
  const scale = Math.min(1, maxSide / Math.max(rotated.w, rotated.h));
  const outW = Math.max(1, Math.round(rotated.w * scale));
  const outH = Math.max(1, Math.round(rotated.h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas-Kontext nicht verfügbar");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((page.rotation * Math.PI) / 180);
  const drawW = crop.w * scale;
  const drawH = crop.h * scale;
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    -drawW / 2,
    -drawH / 2,
    drawW,
    drawH,
  );
  ctx.restore();

  const blob = await canvasToJpegBlob(canvas, quality);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

async function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Bild konnte nicht geladen werden"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rotateDimensions(
  w: number,
  h: number,
  rotation: Rotation,
): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
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

export function formatLocalIso(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`;
}
