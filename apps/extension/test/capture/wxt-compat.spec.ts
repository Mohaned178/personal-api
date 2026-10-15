import { expect, it } from "vitest";
import type { CaptureBrowserApi, CaptureListenerApi } from "../../lib/capture";

type RealBrowser = typeof import("wxt/browser")["browser"];

// Compile-time check, enforced by `pnpm --filter extension typecheck`: WXT's real `browser`
// object can be handed to the capture engine and to registerCaptureListeners as is, so the
// background entrypoint needs no adapter.
it("accepts WXT's real browser type for the query and listener sides (type-level)", () => {
  const asQueries = (real: RealBrowser): CaptureBrowserApi => real;
  const asListeners = (real: RealBrowser): CaptureListenerApi => real;
  expect(typeof asQueries).toBe("function");
  expect(typeof asListeners).toBe("function");
});
