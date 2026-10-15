import type { CaptureGate } from "../capture";
import { createCaptureEngine, registerCaptureListeners } from "../capture";
import { type Connection, getConnection } from "../connect";
import { createFlusher } from "./flush";
import type { BackgroundBrowserApi, BackgroundDeps, WiredBackground } from "./types";

const unavailable = (): Promise<never> =>
  Promise.reject(new Error("not available to the background wiring"));

/** The stored connection, read through `getConnection` (null when absent, malformed or unreadable). */
function readStoredConnection(browser: BackgroundBrowserApi): Promise<Connection | null> {
  return getConnection({
    storage: {
      get: (key) => browser.storage.local.get(key),
      set: unavailable,
      remove: unavailable,
    },
    permissions: { request: unavailable, remove: unavailable },
    fetch: unavailable,
  });
}

/**
 * Everything `entrypoints/background.ts` does, with the browser injected. Called synchronously at
 * the top level of the background: every listener is registered before this returns, and nothing
 * is awaited first. The async start-up work runs in `ready`.
 */
export function wireBackground(deps: BackgroundDeps): WiredBackground {
  const { browser, store } = deps;

  const flusher = createFlusher({
    store,
    getConnection: () => readStoredConnection(browser),
    fetch: deps.fetch,
    alarms: browser.alarms,
    now: deps.now,
    random: deps.random,
  });

  // Deny by default, fail closed (invariant 1): capture needs a stored connection, an ingest key
  // that was not refused, and a collect gate that answers exactly `true`. M2-07 supplies the gate.
  const gate: CaptureGate = {
    async allows(page) {
      try {
        if ((await flusher.getSyncStatus()).state !== "connected") return false;
        if (deps.collectGate === undefined) return false;
        return (await deps.collectGate.allows(page)) === true;
      } catch {
        return false;
      }
    },
  };

  const engine = createCaptureEngine({
    browser,
    store,
    gate,
    now: deps.now,
    newId: deps.newId,
    newTabRef: deps.newTabRef,
  });

  registerCaptureListeners(browser, engine);
  // The capture listeners handle the heartbeat tick for the engine; this one runs the flush for
  // the same tick and for the one-shot retry alarm. The flush never touches the heartbeat alarm.
  browser.alarms.onAlarm.addListener((alarm) => flusher.onAlarm(alarm));

  const settled = (work: () => Promise<void>): Promise<void> => {
    try {
      return work().then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  };
  const ready = Promise.all([settled(() => engine.start()), settled(() => flusher.start())]).then(
    () => undefined,
  );

  return { engine, flusher, gate, ready };
}
