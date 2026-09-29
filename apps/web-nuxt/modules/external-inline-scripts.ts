import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defineNuxtModule } from "nuxt/kit";

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")([^>]*)>([\s\S]*?)<\/script>/g;

export function externaliseInlineScripts(
  html: string,
  assetsDir: string,
): { html: string; files: { name: string; body: string }[] } {
  const files: { name: string; body: string }[] = [];
  const rewritten = html.replace(INLINE_SCRIPT, (match, attrs: string, body: string) => {
    if (!body.trim()) return match;
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
    const name = `boot.${hash}.js`;
    files.push({ name, body });
    return `<script${attrs} src="${assetsDir}${name}"></script>`;
  });
  return { html: rewritten, files };
}

export default defineNuxtModule({
  meta: { name: "external-inline-scripts" },
  setup(_options, nuxt) {
    const assetsDir = nuxt.options.app.buildAssetsDir;
    nuxt.hook("nitro:init", (nitro) => {
      nitro.hooks.hook("prerender:generate", async (route) => {
        if (!route.fileName?.endsWith(".html") || !route.contents) return;
        const { html, files } = externaliseInlineScripts(route.contents, assetsDir);
        if (files.length === 0) return;
        const dir = join(nitro.options.output.publicDir, assetsDir);
        await mkdir(dir, { recursive: true });
        for (const file of files) await writeFile(join(dir, file.name), file.body, "utf8");
        route.contents = html;
      });
    });
  },
});
