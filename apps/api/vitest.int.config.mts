import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Integration tests: need Docker (Testcontainers). Run with `pnpm test:int`.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.int.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
