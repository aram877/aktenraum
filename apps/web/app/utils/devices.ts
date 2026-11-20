/**
 * "Chrome · Windows" from a user agent, for the device list in
 * /settings → Konto. A handful of regexes for the browsers and systems that
 * matter — no UA library. Order matters: Edge and Opera also say "Chrome",
 * Chrome also says "Safari", iOS browsers all say "Safari".
 */

const BROWSERS: [RegExp, string][] = [
  [/\bEdgA?\/|\bEdgiOS\//, "Edge"],
  [/\bOPR\/|\bOPiOS\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone|\biPad|\biPod/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export const UNKNOWN_DEVICE = "Unbekanntes Gerät";

function first(table: [RegExp, string][], agent: string): string | null {
  return table.find(([pattern]) => pattern.test(agent))?.[1] ?? null;
}

export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return UNKNOWN_DEVICE;
  const browser = first(BROWSERS, userAgent);
  const system = first(SYSTEMS, userAgent);
  if (browser === null && system === null) return UNKNOWN_DEVICE;
  return [browser, system].filter((part) => part !== null).join(" · ");
}
