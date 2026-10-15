import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { createIdbCaptureStore, wireBackground } from "../lib/queue";

// The background can be killed at any time (service worker on Edge, event page on Firefox), so
// every listener is registered synchronously here at the top level and all state lives in
// IndexedDB, `browser.storage` and `browser.alarms`.
export default defineBackground(() => {
  const random = (): number => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;
  const newTabRef = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_");
  };

  // No collect gate yet (M2-07 adds the first one), so everything is denied (invariant 1).
  void wireBackground({
    browser,
    store: createIdbCaptureStore({ now: Date.now }),
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    random,
    newId: () => crypto.randomUUID(),
    newTabRef,
  }).ready;
});
