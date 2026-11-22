// Colour mode (dark-mode change): System follows the device, Hell / Dunkel
// override it. Pure helpers; storage and the DOM live in useColorMode.

export type ColorMode = "system" | "light" | "dark";
export type ResolvedColorMode = "light" | "dark";

export const COLOR_MODE_STORAGE_KEY = "aktenraum-color-mode";
export const COLOR_MODES: readonly ColorMode[] = ["system", "light", "dark"];

export function parseColorMode(value: unknown): ColorMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveColorMode(mode: ColorMode, systemDark: boolean): ResolvedColorMode {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

/** System → Hell → Dunkel → System. */
export function nextColorMode(mode: ColorMode): ColorMode {
  return COLOR_MODES[(COLOR_MODES.indexOf(mode) + 1) % COLOR_MODES.length]!;
}

export function colorModeLabel(mode: ColorMode): string {
  return mode === "light" ? "Hell" : mode === "dark" ? "Dunkel" : "System";
}
