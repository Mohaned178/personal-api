import { ALLOW_LIST_STORAGE_KEY, createAllowListGate } from "../allow-list";
import type { CaptureGate } from "../capture";
import { createCaptureEngine, registerCaptureListeners } from "../capture";
import { CONNECTION_STORAGE_KEY, type Connection, getConnection } from "../connect";
import { CLIENT_VERSION, createHeartbeatSender } from "../heartbeat";
import { getPaused, PAUSED_STORAGE_KEY } from "../pause";
import { createFlusher } from "./flush";
import { connectionState } from "./sync-state";
import type { BackgroundBrowserApi, BackgroundDeps, WiredBackground } from "./types";

/** What the capture gate reads from `browser.storage.local`, in one call. */
const GATE_STORAGE_KEYS = [CONNECTION_STORAGE_KEY, PAUSED_STORAGE_KEY, ALLOW_LIST_STORAGE_KEY];

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

  // Deny by default, fail closed (invariant 1): capture needs a stored connection, an ingest key
  // that was not refused, the user not paused and a collect gate that answers exactly `true`.
  //
  // This runs on the capture path (ADR 0002 decision 3), so it is as short as it can be: ONE
  // `storage.local.get` for the connection, the pause flag and the allow list, started at once and
  // in parallel with the one IndexedDB read of the sync state (a 401 marker), instead of four
  // sequential reads. Nothing is cached: every call reads fresh, so a pause or a removed domain
  // takes effect on the next navigation. The values still go through their own parsers
  // (`getConnection`, `getPaused`, `getAllowList` via the allow-list gate), each of which fails
  // closed on a missing, malformed or unreadable value, and a failed read fails all of them.
  // The M2-07 temporary allow list is the default collect gate (read-only here: `set` rejects, the
  // popup owns writes); an explicit `collectGate` (tests, later milestones) wins.
  const gate: CaptureGate = {
    async allows(page) {
      try {
        const snapshot = browser.storage.local.get(GATE_STORAGE_KEYS);
        const view = { get: () => snapshot, set: unavailable };
        const collectGate = deps.collectGate ?? createAllowListGate(view);
        const [connection, paused, collected, meta] = await Promise.all([
          getConnection({
            storage: { get: view.get, set: unavailable, remove: unavailable },
            permissions: { request: unavailable, remove: unavailable },
            fetch: unavailable,
          }),
          getPaused(view),
          collectGate.allows(page),
          store.getMeta(),
        ]);
        if ((await connectionState(connection, meta.sync)) !== "connected") return false;
        if (paused) return false;
        return collected === true;
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
