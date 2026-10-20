import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

const API_ORIGIN = "http://localhost:3000";

const presentAsApiOrigin: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyReq", (proxyReq) => {
    if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", API_ORIGIN);
  });
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // The API owns /api/auth (Better Auth) and /v1 (platform endpoints, from M1); proxying both
    // keeps the dashboard same-origin in dev, like it is when the API serves the build. Better Auth
    // only trusts BETTER_AUTH_URL's origin, so the proxy presents :5173 requests as that origin;
    // otherwise every auth POST (sign in, sign up, sign out) is a 403 in dev.
    proxy: {
      "/api": { target: API_ORIGIN, configure: presentAsApiOrigin },
      "/v1": { target: API_ORIGIN, configure: presentAsApiOrigin },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
  },
});
