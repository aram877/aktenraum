import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev mode: Vite serves on :5173 and proxies /api to nginx on :80, which in turn
// routes /api to aktenraum-api. So `pnpm dev` works against the running compose
// stack with no CORS plumbing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:80",
        changeOrigin: true,
      },
    },
  },
});
