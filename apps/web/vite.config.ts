import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // The API owns /api/auth (Better Auth) and /v1 (platform endpoints, from M1); proxying both
    // keeps the dashboard same-origin in dev, like it is when the API serves the build.
    proxy: {
      "/api": "http://localhost:3000",
      "/v1": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
  },
});
