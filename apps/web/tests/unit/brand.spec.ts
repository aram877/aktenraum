import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mountSuspended } from "@nuxt/test-utils/runtime";
import { describe, expect, it } from "vitest";

import AppLogo from "~/components/AppLogo.vue";

// Tests run from the package root (apps/web), also under `pnpm -r test`.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

/** `x y w h rx transform` of every <rect>, so geometry drift between copies fails. */
function rects(markup: string): string[] {
  return [...markup.matchAll(/<rect\b([^>]*)\/?>/g)].map((m) => {
    const attr = (name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "";
    return ["x", "y", "width", "height", "rx", "transform"].map(attr).join(" ").trim();
  });
}

describe("Stapel logo", () => {
  it("uses the same sheet geometry in the component, the favicon and the icon generator", async () => {
    const big = await mountSuspended(AppLogo, { props: { size: 64 } });
    const fromComponent = rects(big.html());
    expect(fromComponent).toHaveLength(4); // back, middle, front, tab

    // favicon.svg is the simplified mark: the three sheets, no tab.
    expect(rects(read("public/favicon.svg"))).toEqual(fromComponent.slice(0, 3));

    const script = read("../../scripts/brand/make-icons.py");
    expect(script).toContain("BACK = (20, 7, 32, 42, 5, 9, (36, 28))");
    expect(script).toContain("MID = (13, 11, 32, 42, 5, -7, (29, 32))");
    expect(script).toContain("FRONT = (16, 14, 32, 42, 5)");
    expect(script).toContain("TAB = (22, 20, 9, 3.4, 1.7)");
  });

  it("drops lines and tab below 24 px", async () => {
    const small = await mountSuspended(AppLogo, { props: { size: 16 } });
    expect(rects(small.html())).toHaveLength(3);
    expect(small.find("path").exists()).toBe(false);
  });

  it("ships every icon the head and the manifest point to", () => {
    const manifest = JSON.parse(read("public/site.webmanifest")) as { icons: { src: string }[] };
    const config = read("nuxt.config.ts");
    const hrefs = [...config.matchAll(/href: "(\/[^"]+)"/g)].map((m) => m[1]!);
    for (const path of [...manifest.icons.map((i) => i.src), ...hrefs]) {
      expect(() => read(`public${path}`), path).not.toThrow();
    }
  });
});
