import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyColorMode, useColorMode } from "~/composables/useColorMode";
import { COLOR_MODE_STORAGE_KEY, colorModeLabel, nextColorMode, parseColorMode, resolveColorMode } from "~/utils/color-mode";

// Tests run from the package root (apps/web), also under `pnpm -r test`.
const CSS = readFileSync(resolve(process.cwd(), "app/assets/css/main.css"), "utf8");

/** Token values of one block (`@theme {…}` for light, `:root.dark {…}` for dark). */
function tokens(block: "@theme" | ":root.dark"): Record<string, string> {
  const start = CSS.indexOf(`${block} {`);
  const body = CSS.slice(start, CSS.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("colour mode helpers", () => {
  it("parses stored values, defaulting to System", () => {
    expect(parseColorMode("dark")).toBe("dark");
    expect(parseColorMode("light")).toBe("light");
    expect(parseColorMode("blau")).toBe("system");
    expect(parseColorMode(null)).toBe("system");
  });

  it("resolves System from the device setting", () => {
    expect(resolveColorMode("system", true)).toBe("dark");
    expect(resolveColorMode("system", false)).toBe("light");
    expect(resolveColorMode("light", true)).toBe("light");
    expect(resolveColorMode("dark", false)).toBe("dark");
  });

  it("cycles System → Hell → Dunkel → System", () => {
    expect([nextColorMode("system"), nextColorMode("light"), nextColorMode("dark")]).toEqual(["light", "dark", "system"]);
    expect(colorModeLabel("dark")).toBe("Dunkel");
  });
});

describe("useColorMode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(COLOR_MODE_STORAGE_KEY);
    useColorMode().set("system");
  });

  it("stores the choice and puts the class on <html>", () => {
    const mode = useColorMode();
    mode.set("dark");
    expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    mode.cycle();
    expect(mode.mode.value).toBe("system");
    expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBeNull();
  });

  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mode = useColorMode();
    expect(() => mode.set("light")).not.toThrow();
    expect(mode.mode.value).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("applyColorMode switches between the two classes", () => {
    applyColorMode("dark");
    applyColorMode("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});

describe("theme tokens", () => {
  const light = tokens("@theme");
  const dark = tokens(":root.dark");

  it("defines a dark value for every light colour token", () => {
    for (const name of Object.keys(light)) expect(dark[name], name).toBeDefined();
  });

  it("keeps secondary text and status colours readable in both themes", () => {
    for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
      for (const fg of ["ink", "ink-muted", "ink-subtle", "tone-danger", "tone-warning", "tone-info", "accent"]) {
        for (const bg of ["canvas", "surface"]) {
          expect(contrast(t[fg]!, t[bg]!), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps remapped alert colours readable in dark (text on its own box)", () => {
    for (const [fg, bg] of [["red-700", "red-50"], ["amber-800", "amber-50"], ["emerald-800", "emerald-50"], ["sky-800", "sky-100"]]) {
      expect(contrast(dark[fg]!, dark[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
