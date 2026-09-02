import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // The frontend is a static container; in local dev the SPA uses relative /api/*
  // and the Vite server proxies them to the API gateway (server-side, so no
  // browser CORS). The SPA itself never hardcodes the gateway in dev — see
  // src/lib/apiRouting.ts (VITE_API_BASE_URL, baked only in the prod build).
  const devApiProxy = env.VITE_DEV_API_PROXY || "https://api.stride-running.cn";
  // Strength illustrations are baked into the static frontend container. In local
  // dev, serve them from the prod frontend host (the static container) so the
  // SPA's relative /strength_illustrations/* URLs resolve.
  const devStrengthProxy = env.VITE_DEV_STRENGTH_PROXY || "https://stride-running.cn";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": { target: devApiProxy, changeOrigin: true, secure: true },
        "/strength_illustrations": { target: devStrengthProxy, changeOrigin: true, secure: true },
      },
    },
  };
});
