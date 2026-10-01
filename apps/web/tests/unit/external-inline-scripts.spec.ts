import { describe, expect, it } from "vitest";

import { externaliseInlineScripts } from "../../modules/external-inline-scripts";

describe("externaliseInlineScripts", () => {
  it("moves an executable inline script into a hashed file", () => {
    const { html, files } = externaliseInlineScripts(
      '<body><script>window.__NUXT__={}</script></body>',
      "/_nuxt/",
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.body).toBe("window.__NUXT__={}");
    expect(html).toBe(`<body><script src="/_nuxt/${files[0]?.name}"></script></body>`);
  });

  it("leaves JSON data blocks and external scripts alone", () => {
    const input =
      '<script type="application/json" id="__NUXT_DATA__">[1]</script><script type="module" src="/_nuxt/a.js"></script>';
    const { html, files } = externaliseInlineScripts(input, "/_nuxt/");
    expect(files).toHaveLength(0);
    expect(html).toBe(input);
  });

  it("names files by content so identical scripts share one file", () => {
    const a = externaliseInlineScripts("<script>x=1</script>", "/_nuxt/");
    const b = externaliseInlineScripts("<script>x=1</script>", "/_nuxt/");
    expect(a.files[0]?.name).toBe(b.files[0]?.name);
  });
});
