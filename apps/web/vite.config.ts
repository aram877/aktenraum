import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Avoid pulling @types/node just to read env vars at config time.
declare const process: { cwd(): string };

// Dev mode: Vite serves on :5173 and proxies /api to nginx, which routes
// /api to aktenraum-api. With the compose stack up, `pnpm dev` works
// without any CORS plumbing.
//
// Two knobs (read from .env / shell env):
//   - VITE_API_PROXY_TARGET (default http://localhost:8080) — where /api
//     goes. Must match where nginx is published; the compose default is
//     :8080 and is overridable via AKTENRAUM_WEB_PORT in docker/.env.
//   - VITE_HOST (default 0.0.0.0) — Vite bind address. 0.0.0.0 exposes
//     the dev server on the LAN so a second device can hit
//     http://<dev-ip>:5173.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET || "http://localhost:8080";
  const host = env.VITE_HOST || "0.0.0.0";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host,
      port: 5173,
      // Accept any Host header. Vite 5+ rejects unknown hosts by default,
      // which breaks LAN access (a phone hitting http://192.168.1.x:5173
      // sends `Host: 192.168.1.x` and Vite would 403 it).
      allowedHosts: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
