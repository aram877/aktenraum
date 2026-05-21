import type { Rotation, ScanAction, ScanPage, ScanState } from "./scan-types";

function rotateOnce(r: Rotation): Rotation {
  return ((r + 90) % 360) as Rotation;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case "add": {
      const next: ScanPage = {
        id: makeId(),
        blob: action.blob,
        rotation: 0,
        crop: null,
      };
      return { pages: [...state.pages, next] };
    }
    case "remove": {
      const pages = state.pages.filter((p) => p.id !== action.id);
      if (pages.length === state.pages.length) return state;
      return { pages };
    }
    case "rotate": {
      let touched = false;
      const pages = state.pages.map((p) => {
        if (p.id !== action.id) return p;
        touched = true;
        return { ...p, rotation: rotateOnce(p.rotation) };
      });
      return touched ? { pages } : state;
    }
    case "reorder": {
      if (state.pages.length < 2) return state;
      const lastIndex = state.pages.length - 1;
      const from = clamp(action.from, 0, lastIndex);
      const to = clamp(action.to, 0, lastIndex);
      if (from === to) return state;
      const pages = state.pages.slice();
      const [moved] = pages.splice(from, 1);
      if (!moved) return state;
      pages.splice(to, 0, moved);
      return { pages };
    }
    case "crop": {
      let touched = false;
      const pages = state.pages.map((p) => {
        if (p.id !== action.id) return p;
        touched = true;
        return { ...p, crop: action.crop };
      });
      return touched ? { pages } : state;
    }
    case "replace": {
      let touched = false;
      const pages = state.pages.map((p) => {
        if (p.id !== action.id) return p;
        touched = true;
        return { ...p, blob: action.blob, crop: null };
      });
      return touched ? { pages } : state;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
