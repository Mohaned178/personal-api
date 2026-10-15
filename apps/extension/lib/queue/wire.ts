import { createAllowListGate } from "../allow-list";
import type { CaptureGate } from "../capture";
import { createCaptureEngine, registerCaptureListeners } from "../capture";
import { type Connection, getConnection } from "../connect";
import { CLIENT_VERSION, createHeartbeatSender } from "../heartbeat";
import { getPaused } from "../pause";
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

  const heartbeat = createHeartbeatSender({
    store,
    getConnection: () => readStoredConnection(browser),
    fetch: deps.fetch,
    alarms: browser.alarms,
    now: deps.now,
    clientVersion: CLIENT_VERSION,
  });

  // The M2-07 temporary allow list is the default gate; an explicit `collectGate` (tests, later
  // milestones) wins. The list is read-only here: `addAllowedDomain`/`removeAllowedDomain` are the
  // popup's business, so `set` rejects like it does for the stored connection.
  const collectGate =
    deps.collectGate ??
    createAllowListGate({
      get: (key) => browser.storage.local.get(key),
      set: unavailable,
    });

  // Deny by default, fail closed (invariant 1): capture needs a stored connection, an ingest key
  // that was not refused, the user not paused and a collect gate that answers exactly `true`.
  const gate: CaptureGate = {
    async allows(page) {
      try {
        if ((await flusher.getSyncStatus()).state !== "connected") return false;
        if (await getPaused(browser.storage.local)) return false;
        return (await collectGate.allows(page)) === true;
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
  // The server heartbeat has its own periodic alarm; it runs whether or not capture is paused.
  browser.alarms.onAlarm.addListener((alarm) => heartbeat.onAlarm(alarm));

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
  const ready = Promise.all([
    settled(() => engine.start()),
    settled(() => flusher.start()),
    settled(() => heartbeat.start()),
  ]).then(() => undefined);

  return { engine, flusher, gate, ready };
}
