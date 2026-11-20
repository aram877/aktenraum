import { describe, expect, it } from "vitest";

import { UNKNOWN_DEVICE, deviceLabel } from "~/utils/devices";

const AGENTS: [string, string][] = [
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Chrome · Windows",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    "Edge · Windows",
  ],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox · Windows"],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Safari · macOS",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Chrome · macOS",
  ],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox · macOS"],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    "Edge · macOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Safari · iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    "Chrome · iOS",
  ],
  [
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
    "Firefox · iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/131.0.2903.68 Version/18.0 Mobile/15E148 Safari/604.1",
    "Edge · iOS",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36",
    "Chrome · Android",
  ],
  ["Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0", "Firefox · Android"],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.2903.70",
    "Edge · Android",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Chrome · Linux",
  ],
  ["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox · Linux"],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    "Edge · Linux",
  ],
];

describe("deviceLabel", () => {
  it.each(AGENTS)("%s → %s", (agent, label) => {
    expect(deviceLabel(agent)).toBe(label);
  });

  it("falls back for missing or unrecognisable user agents", () => {
    expect(deviceLabel(null)).toBe(UNKNOWN_DEVICE);
    expect(deviceLabel(undefined)).toBe(UNKNOWN_DEVICE);
    expect(deviceLabel("")).toBe(UNKNOWN_DEVICE);
    expect(deviceLabel("curl/8.5.0")).toBe(UNKNOWN_DEVICE);
  });

  it("shows what it recognises when only one part is known", () => {
    expect(deviceLabel("SomeBot (Windows NT 10.0)")).toBe("Windows");
  });
});
