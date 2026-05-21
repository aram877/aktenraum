export type Rotation = 0 | 90 | 180 | 270;

export type ScanCrop = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ScanPage = {
  id: string;
  blob: Blob;
  rotation: Rotation;
  crop: ScanCrop | null;
};

export type ScanState = {
  pages: ScanPage[];
};

export type ScanAction =
  | { type: "add"; blob: Blob }
  | { type: "remove"; id: string }
  | { type: "rotate"; id: string }
  | { type: "reorder"; from: number; to: number }
  | { type: "crop"; id: string; crop: ScanCrop | null }
  | { type: "replace"; id: string; blob: Blob };

export const initialScanState: ScanState = { pages: [] };

export const MAX_PAGES = 30;
