import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2026-09-01",
  ssr: false,
  devtools: { enabled: false },
  experimental: { entryImportMap: false },
  modules: ["@nuxt/eslint", "@nuxt/test-utils/module"],
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      title: "aktenraum",
      htmlAttrs: { lang: "de" },
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
      link: [{ rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  hooks: {
    "prerender:routes"({ routes }) {
      for (const route of [...routes]) if (route !== "/") routes.delete(route);
    },
  },
  nitro: {
    devProxy: {
      "/api": { target: "http://localhost:8080/api", changeOrigin: false },
    },
  },
});
