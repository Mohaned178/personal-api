import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits the decorator metadata that Nest's dependency injection needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { include: ["src/**/*.spec.ts"] },
});
