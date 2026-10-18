import type { CaptureGate } from "../capture";
import { createCaptureEngine, registerCaptureListeners } from "../capture";
import { CONNECTION_STORAGE_KEY, type Connection, getConnection } from "../connect";
import {
  connectionOwner,
  createGateMirror,
  GATE_DISCONNECT_STORAGE_KEY,
  GATE_MIRROR_STORAGE_KEYS,
  GATE_OWNER_STORAGE_KEY,
  parseGateDisconnect,
  parseGateOwner,
  sameQueueOwner,
} from "../gate-mirror";
import { CLIENT_VERSION, createHeartbeatSender } from "../heartbeat";
import { getPaused, PAUSED_STORAGE_KEY } from "../pause";
import { RULES_STORAGE_KEY, readActiveRules } from "../rules/active-rules";
import { createRulesGate } from "../rules/gate";
import { createRuleStore } from "../rules/rule-store";
import { createRulesSync } from "../rules/sync";
import { createFlusher } from "./flush";
import { connectionState } from "./sync-state";
import type { BackgroundBrowserApi, BackgroundDeps, WiredBackground } from "./types";

/**
 * What the capture gate reads from `browser.storage.local`, in ONE call (ADR 0002 decision 3): the
 * connection, the pause flag, the fetched rules and the mirror of the queue owner and of the 401
 * marker (lib/gate-mirror.ts). Nothing else is awaited by the gate.
 */
const GATE_STORAGE_KEYS = [
  CONNECTION_STORAGE_KEY,
  PAUSED_STORAGE_KEY,
  RULES_STORAGE_KEY,
  ...GATE_MIRROR_STORAGE_KEYS,
];

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

  const mirror = createGateMirror({ storage: browser.storage.local, store });

  const flusher = createFlusher({
    store,
    getConnection: () => readStoredConnection(browser),
    fetch: deps.fetch,
    alarms: browser.alarms,
    now: deps.now,
    random: deps.random,
    gateMirror: mirror,
  });

  const rulesSync = createRulesSync({
    getConnection: () => readStoredConnection(browser),
    storage: {
      get: (key) => browser.storage.local.get(key),
      set: (items) => browser.storage.local.set(items),
      remove: (key) => browser.storage.local.remove(key),
    },
    fetch: deps.fetch,
    alarms: browser.alarms,
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
  // This runs on the capture path (ADR 0002 decision 3), so it is as short as it can be: exactly
  // ONE `storage.local.get`, and no IndexedDB. It returns the connection, the pause flag, the rules
  // fetched from the server and the mirror (lib/gate-mirror.ts) of the two facts that live in
  // IndexedDB: the queue owner and the 401 marker. The only other await is a SHA-256 of the ingest
  // key, and only when the mirror says a key was refused. Nothing is cached: every call reads
  // fresh, so a pause or a rule change takes effect on the next navigation. The values still go
  // through their own parsers (`getConnection`, `getPaused`, `readActiveRules`), each of which
  // fails closed on a missing, malformed or unreadable value, and a failed read fails all of them.
  //
  // The collect gate is the rules gate (lib/rules/gate.ts): the first of two layers. It keeps a
  // denied page out of the engine's state. The second layer decides every real event inside the
  // commit (`createRuleStore` below). An explicit `collectGate` (tests) replaces both layers.
  //
  // Deny unless ALL hold: a stored connection; a well-formed mirror whose owner equals that
  // connection's {serverOrigin, integrationId} (events are stamped with the store's owner, and only
  // rows of the connection's owner are ever sent, so a mismatch would queue events that can never
  // be sent); the mirrored 401 marker does not match this key; not paused; the collect gate says
  // exactly `true`.
  const gate: CaptureGate = {
    async allows(page) {
      try {
        const snapshot = browser.storage.local.get(GATE_STORAGE_KEYS);
        const view = { get: () => snapshot, set: unavailable };
        const collectGate = deps.collectGate ?? createRulesGate(view);
        const [raw, connection, paused, collected] = await Promise.all([
          snapshot,
          getConnection({
            storage: { get: view.get, set: unavailable, remove: unavailable },
            permissions: { request: unavailable, remove: unavailable },
            fetch: unavailable,
          }),
          getPaused(view),
          collectGate.allows(page),
        ]);
        const owner = parseGateOwner(raw[GATE_OWNER_STORAGE_KEY]);
        const disconnect = parseGateDisconnect(raw[GATE_DISCONNECT_STORAGE_KEY]);
        if (connection === null || owner === null || disconnect === null) return false;
        if (!sameQueueOwner(owner, connectionOwner(connection))) return false;
        const state = await connectionState(connection, {
          state: disconnect.disconnectedFor === null ? "connected" : "disconnected",
          disconnectedFor: disconnect.disconnectedFor,
        });
        if (state !== "connected") return false;
        if (paused) return false;
        return collected === true;
      } catch {
        return false;
      }
    },
  };

  // At every start: an unowned queue (rows from before owners existed, or a store whose owner was
  // never set) takes the paired connection's owner, so new events are stamped and flushable. Rows
  // already in it keep no owner and stay unsent (`setOwner` never re-stamps). A queue owned by
  // someone else is left alone: the gate denies and the flusher sends nothing until the user pairs
  // again. Then the gate's mirror is rewritten from IndexedDB, the source of truth.
  async function startMirror(): Promise<void> {
    try {
      const connection = await readStoredConnection(browser);
      if (connection !== null && (await store.getOwner()) === null) {
        await store.setOwner(connectionOwner(connection));
      }
    } finally {
      await mirror.refresh();
    }
  }

  // Layer two. With an explicit `collectGate` (tests) the events are not run through the rules.
  const captureStore =
    deps.collectGate === undefined
      ? createRuleStore({ store, loadRules: () => readActiveRules(browser.storage.local) })
      : store;

  const engine = createCaptureEngine({
    browser,
    store: captureStore,
    gate,
    now: deps.now,
    newId: deps.newId,
    newTabRef: deps.newTabRef,
  });

  registerCaptureListeners(browser, engine);
  // The capture listeners handle the heartbeat tick for the engine; this one runs the flush for
  // the same tick and for the one-shot retry alarm. The flush never touches the heartbeat alarm.
  // After each flush the gate's mirror is rewritten from IndexedDB, so a stale mirror (a kill or a
  // race between the two writes) heals within one alarm period instead of at the next start.
  browser.alarms.onAlarm.addListener((alarm) => {
    const work = flusher.onAlarm(alarm);
    return work === undefined ? undefined : work.then(() => mirror.refresh());
  });
  // The server heartbeat has its own periodic alarm; it runs whether or not capture is paused.
  browser.alarms.onAlarm.addListener((alarm) => heartbeat.onAlarm(alarm));
  // The rules have their own periodic alarm too (GET /v1/ingest/config with an ETag).
  browser.alarms.onAlarm.addListener((alarm) => rulesSync.onAlarm(alarm));

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
  // The mirror comes first: the engine's start-up reconciliation asks the gate, and a missing mirror
  // denies.
  const ready = settled(() => startMirror())
    .then(() =>
      Promise.all([
        settled(() => engine.start()),
        settled(() => flusher.start()),
        settled(() => heartbeat.start()),
        settled(() => rulesSync.start()),
      ]),
    )
    .then(() => undefined);

  return { engine, flusher, rulesSync, gate, ready };
}
