import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits the decorator metadata that Nest's dependency injection needs (esbuild does not).
// Integration tests (*.int.spec.ts, need Docker) run only through vitest.int.config.mts.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    exclude: ["**/*.int.spec.ts", "**/node_modules/**"],
  },
});
