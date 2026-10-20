// M2-05 background wiring: listeners at the top level, a gate that fails closed, flush alarms.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_ALARM_NAME } from "../../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import {
  GATE_DISCONNECT_STORAGE_KEY,
  GATE_MIRROR_STORAGE_KEYS,
  GATE_OWNER_STORAGE_KEY,
} from "../../lib/gate-mirror";
import { CONNECT_DONE_PATH, ONE_CLICK_STORAGE_KEY } from "../../lib/one-click";
import { type BackgroundBrowserApi, FLUSH_RETRY_ALARM_NAME, wireBackground } from "../../lib/queue";
import { keyMarker } from "../../lib/queue/key-marker";
import {
  connectionFor,
  INTEGRATION_ID_2,
  KEY,
  KEY_2,
  mirrorFor,
  ORIGIN_2,
  ownerOf,
  pageEvents,
  pick,
  tick,
  World,
  withOverrides,
} from "./support/world";

type Listener = (...args: never[]) => unknown;

function fakeBrowser(
  world: World,
  stored: Record<string, unknown>,
  session: Record<string, unknown> = {},
  removedTabs: number[] = [],
) {
  const listeners = new Map<string, Listener[]>();
  const source = (name: string) => ({
    addListener(listener: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
  });
  const browser = {
    tabs: {
      onCreated: source("tabs.onCreated"),
      onUpdated: source("tabs.onUpdated"),
      onActivated: source("tabs.onActivated"),
      onRemoved: source("tabs.onRemoved"),
      query: async () => [],
      remove: async (tabId: number) => void removedTabs.push(tabId),
    },
    windows: {
      onFocusChanged: source("windows.onFocusChanged"),
      getLastFocused: async () => ({ focused: false, incognito: false }),
    },
    idle: {
      onStateChanged: source("idle.onStateChanged"),
      queryState: async () => "active" as const,
      setDetectionInterval: () => undefined,
    },
    alarms: {
      onAlarm: source("alarms.onAlarm"),
      get: async () => ({ name: HEARTBEAT_ALARM_NAME }),
      create: (name: string, info: { when: number } | { periodInMinutes: number }) =>
        world.alarms.create(name, info as { when: number }),
      clear: (name: string) => world.alarms.clear(name),
    },
    runtime: {
      onStartup: source("runtime.onStartup"),
      onInstalled: source("runtime.onInstalled"),
    },
    storage: {
      session: {
        get: async (key: string) => pick(session, key),
        set: async (items: Record<string, unknown>) => void Object.assign(session, items),
        remove: async (key: string) => void delete session[key],
      },
      local: {
        get: async (keys: string | string[]) => pick(stored, keys),
        set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete stored[key];
        },
      },
    },
  } satisfies BackgroundBrowserApi;
  return { browser, listeners };
}

/**
 * The fake ingest server, except the rules route: the rules sync (M4-06) runs at start and is not
 * what these tests count, so it gets a 404 that is not recorded as a server call.
 */
const serverFetch = (url: string, init: RequestInit): Promise<Response> =>
  url.endsWith("/v1/ingest/config")
    ? Promise.resolve(new Response(null, { status: 404 }))
    : url.endsWith("/v1/pair")
      ? pairFetch(url, init)
      : world.server.fetch(url, init);

/** `POST /v1/pair` for the one-click test: records the code it was sent, answers a pairing. */
const pairCalls: { url: string; body: unknown }[] = [];
async function pairFetch(url: string, init: RequestInit): Promise<Response> {
  pairCalls.push({ url, body: JSON.parse(String(init.body)) });
  const body = {
    integration: {
      id: INTEGRATION_ID_2,
      kind: "browser-extension",
      name: "Firefox",
      defaultPolicy: "deny",
      status: "active",
      lastSeenAt: null,
      createdAt: "2026-10-15T10:00:00.000Z",
    },
    ingestKey: { id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c", key: KEY_2, prefix: "pa_ing_BBBB" },
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

function wire(
  options: {
    allow?: boolean | null;
    connected?: boolean;
    session?: Record<string, unknown>;
    removedTabs?: number[];
  } = {},
) {
  const stored: Record<string, unknown> =
    options.connected === false
      ? {}
      : { [CONNECTION_STORAGE_KEY]: connectionFor(KEY), ...mirrorFor() };
  const { browser, listeners } = fakeBrowser(world, stored, options.session, options.removedTabs);
  const { store } = world.open();
  // Events are queued for the paired owner. Called first, so it also precedes the engine's own
  // start-up events (the store runs writes in call order).
  void store.setOwner(ownerOf(connectionFor(KEY)));
  const wired = wireBackground({
    browser,
    store,
    fetch: serverFetch,
    now: world.now,
    random: () => 0,
    newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
    newTabRef: () => "tabref-aaaa1111",
    ...(options.allow === null ? {} : { collectGate: { allows: () => options.allow ?? true } }),
  });
  return { wired, listeners, store, stored };
}

describe("wireBackground", () => {
  it("registers every listener before it returns, including the flush alarm listener", () => {
    const { listeners } = wire();
    // The capture engine's, plus one-click connect's (M8-01).
    expect(listeners.get("tabs.onUpdated")).toHaveLength(2);
    expect(listeners.get("tabs.onRemoved")).toHaveLength(2);
    for (const name of [
      "tabs.onCreated",
      "tabs.onActivated",
      "windows.onFocusChanged",
      "idle.onStateChanged",
      "runtime.onStartup",
      "runtime.onInstalled",
    ]) {
      expect(listeners.get(name), name).toHaveLength(1);
    }
    // flush, server heartbeat, rules sync, plus the capture engine's own heartbeat tick.
    expect(listeners.get("alarms.onAlarm")).toHaveLength(4);
  });

  it("one-click: pairs with the code from the tab it opened, stores the connection, closes the tab", async () => {
    pairCalls.length = 0;
    const session: Record<string, unknown> = {
      [ONE_CLICK_STORAGE_KEY]: { tabId: 9, origin: ORIGIN_2, expiresAt: world.now() + 60_000 },
    };
    const removedTabs: number[] = [];
    const { wired, listeners, stored } = wire({ connected: false, session, removedTabs });
    await wired.ready;
    const done = `${ORIGIN_2}${CONNECT_DONE_PATH}#code=ABCD-EFGH-JKLM-NPQR-STUV`;
    await Promise.all(
      (listeners.get("tabs.onUpdated") ?? []).map((l) =>
        (l as (...a: unknown[]) => unknown)(9, { url: done }, { id: 9, url: done }),
      ),
    );
    expect(pairCalls).toEqual([
      { url: `${ORIGIN_2}/v1/pair`, body: { pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" } },
    ]);
    expect(stored[CONNECTION_STORAGE_KEY]).toMatchObject({
      serverOrigin: ORIGIN_2,
      integrationId: INTEGRATION_ID_2,
    });
    expect(removedTabs).toEqual([9]);
    expect(session[ONE_CLICK_STORAGE_KEY]).toBeUndefined();
    expect(JSON.stringify({ stored, session })).not.toContain("ABCD-EFGH");
  });

  it("ready settles", async () => {
    const { wired } = wire();
    await expect(wired.ready).resolves.toBeUndefined();
  });

  it("denies everything while no collect gate exists", async () => {
    const { wired } = wire({ allow: null });
    expect(await wired.gate.allows(null)).toBe(false);
    expect(await wired.gate.allows({ domain: "a.example", path: "/" })).toBe(false);
  });

  it("allows only when connected, not disconnected and the gate says exactly true", async () => {
    const allowed = wire({ allow: true });
    expect(await allowed.wired.gate.allows(null)).toBe(true);

    const denied = wire({ allow: false });
    expect(await denied.wired.gate.allows(null)).toBe(false);

    const notTrue = wire();
    const odd = wireBackground({
      browser: fakeBrowser(world, { [CONNECTION_STORAGE_KEY]: connectionFor(KEY), ...mirrorFor() })
        .browser,
      store: notTrue.store,
      fetch: serverFetch,
      now: world.now,
      random: () => 0,
      newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
      newTabRef: () => "tabref-aaaa1111",
      collectGate: { allows: (() => "yes") as never },
    });
    expect(await odd.gate.allows(null)).toBe(false);

    const throwing = wireBackground({
      browser: fakeBrowser(world, { [CONNECTION_STORAGE_KEY]: connectionFor(KEY), ...mirrorFor() })
        .browser,
      store: notTrue.store,
      fetch: serverFetch,
      now: world.now,
      random: () => 0,
      newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
      newTabRef: () => "tabref-aaaa1111",
      collectGate: {
        allows: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await throwing.gate.allows(null)).toBe(false);

    const notConnected = wire({ connected: false, allow: true });
    expect(await notConnected.wired.gate.allows(null)).toBe(false);
  });

  it("denies after a 401 until a different key is stored", async () => {
    const { wired, stored, store } = wire({ allow: true });
    await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(1) }));
    world.server.revoke();
    world.connection = connectionFor(KEY);
    await wired.flusher.flush();
    expect(await wired.gate.allows(null)).toBe(false);
    stored[CONNECTION_STORAGE_KEY] = connectionFor("pa_ing_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    expect(await wired.gate.allows(null)).toBe(true);
  });

  it("runs a flush for the heartbeat and retry alarms and ignores other alarms", async () => {
    const { wired, listeners, store } = wire();
    await wired.ready; // the engine may queue its own start-up events
    await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(2) }));
    const onAlarm = listeners.get("alarms.onAlarm") as ((alarm: { name: string }) => unknown)[];
    const flushListener = onAlarm[1] as (alarm: { name: string }) => Promise<void> | undefined;
    expect(flushListener({ name: "other" })).toBeUndefined();
    expect(world.server.calls).toHaveLength(0);
    await flushListener({ name: FLUSH_RETRY_ALARM_NAME });
    expect(world.server.calls.length).toBeGreaterThan(0);
    expect((await store.stats()).depth).toBe(0);
  });
});

// M2-R fix: the capture path gate (ADR 0002 decision 3) is ONE `storage.local.get` and no IndexedDB
// read. The queue owner and the 401 marker are mirrored into storage.local; every missing,
// malformed, stale or mismatched value, and every failed read, denies.
describe("the capture gate's reads", () => {
  type StorageLocal = {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
  };
  type Store = ReturnType<World["open"]>["store"];

  const GATE_KEYS = [
    "connection",
    "paused",
    "rulesConfig",
    GATE_OWNER_STORAGE_KEY,
    GATE_DISCONNECT_STORAGE_KEY,
  ];

  const paired = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    [CONNECTION_STORAGE_KEY]: connectionFor(KEY),
    ...mirrorFor(),
    ...extra,
  });

  function wireWith(
    options: {
      get?: StorageLocal["get"];
      /** Makes `storage.local.set` reject for these items. */
      failSet?: (items: Record<string, unknown>) => boolean;
      store?: (store: Store) => Store;
      stored?: Record<string, unknown>;
      sessionGet?: () => Promise<Record<string, unknown>>;
    } = {},
  ) {
    const stored = options.stored ?? paired();
    const { browser } = fakeBrowser(world, stored);
    const local: StorageLocal = {
      get: options.get ?? (async (keys) => pick(stored, keys)),
      set: async (items) => {
        if (options.failSet?.(items)) throw new Error("storage unavailable");
        Object.assign(stored, items);
      },
      remove: async (keys) => {
        for (const key of [keys].flat()) delete stored[key];
      },
    };
    const session = options.sessionGet
      ? { ...browser.storage.session, get: options.sessionGet }
      : browser.storage.session;
    const opened = world.open();
    const wired = wireBackground({
      browser: { ...browser, storage: { session, local } },
      store: options.store ? options.store(opened.store) : opened.store,
      fetch: serverFetch,
      now: world.now,
      random: () => 0,
      newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
      newTabRef: () => "tabref-aaaa1111",
      collectGate: { allows: () => true },
    });
    return { wired, stored, store: opened.store };
  }

  it("is allowed when every read works (the baseline for the failing cases)", async () => {
    expect(await wireWith().wired.gate.allows(null)).toBe(true);
  });

  it("is ONE storage call for connection, pause, rules and the mirror, and reads no IndexedDB", async () => {
    const calls: (string | string[])[] = [];
    let held: Promise<void> | null = null;
    let release = () => {};
    const reads = { store: 0, session: 0 };
    const guarded = (store: Store): Store =>
      withOverrides(store, {
        getMeta: () => {
          reads.store++;
          return store.getMeta();
        },
        getOwner: () => {
          reads.store++;
          return store.getOwner();
        },
        stats: () => {
          reads.store++;
          return store.stats();
        },
        peekBatch: (limits) => {
          reads.store++;
          return store.peekBatch(limits);
        },
        getDroppedCount: () => {
          reads.store++;
          return store.getDroppedCount();
        },
      });
    const { wired } = wireWith({
      get: async (keys) => {
        calls.push(keys);
        if (held) await held;
        return pick(paired(), keys);
      },
      store: guarded,
      sessionGet: async () => {
        reads.session++;
        return { id: "x" };
      },
    });
    await wired.ready; // start-up work (mirror refresh, the engine's own gate calls) is not measured
    calls.length = 0;
    reads.store = 0;
    reads.session = 0;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const decision = wired.gate.allows(null);
    // While the one storage read is pending, nothing else was started.
    for (let i = 0; i < 20; i++) await tick();
    expect(calls).toEqual([GATE_KEYS]);
    expect(reads).toEqual({ store: 0, session: 0 });
    release();
    expect(await decision).toBe(true);
    expect(calls).toHaveLength(1);
    expect(reads).toEqual({ store: 0, session: 0 });
  });

  it("reads the mirror keys from the shared constants", () => {
    expect(GATE_KEYS.slice(3)).toEqual(GATE_MIRROR_STORAGE_KEYS);
  });

  it("reads fresh on every call (nothing is cached), so a pause takes effect at once", async () => {
    const { wired, stored } = wireWith();
    expect(await wired.gate.allows(null)).toBe(true);
    stored.paused = true;
    expect(await wired.gate.allows(null)).toBe(false);
    stored.paused = false;
    expect(await wired.gate.allows(null)).toBe(true);
  });

  it("denies when the storage read throws synchronously", async () => {
    const { wired } = wireWith({
      get: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(await wired.gate.allows(null)).toBe(false);
  });

  it("denies when the storage read rejects", async () => {
    const { wired } = wireWith({ get: () => Promise.reject(new Error("storage unavailable")) });
    expect(await wired.gate.allows(null)).toBe(false);
    expect(await wired.gate.allows({ domain: "a.example", path: "/" })).toBe(false);
  });

  it("denies when the storage read resolves to something that is not an object", async () => {
    for (const bad of [null, undefined, "nope", 7]) {
      const { wired } = wireWith({ get: async () => bad as never });
      expect(await wired.gate.allows(null), String(bad)).toBe(false);
    }
  });

  it("does not depend on IndexedDB: an unreadable store does not change the decision", async () => {
    const broken = (store: Store): Store =>
      withOverrides(store, {
        getMeta: () => Promise.reject(new Error("indexeddb unavailable")),
        getOwner: () => {
          throw new Error("indexeddb unavailable");
        },
      });
    expect(await wireWith({ store: broken }).wired.gate.allows(null)).toBe(true);
    // ...and the decision still comes from the mirror: a refused key in it denies.
    const refused = paired({
      [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: await keyMarker(KEY) },
    });
    expect(await wireWith({ store: broken, stored: refused }).wired.gate.allows(null)).toBe(false);
  });

  it("denies when the stored values are garbage, whatever the others say", async () => {
    for (const stored of [
      { connection: "nope", ...mirrorFor() },
      { connection: connectionFor(KEY), paused: "yes", ...mirrorFor() },
    ]) {
      const { wired } = wireWith({ stored });
      expect(await wired.gate.allows(null)).toBe(false);
    }
  });

  describe("the mirror", () => {
    const without = (key: string) => {
      const stored = paired();
      delete stored[key];
      return stored;
    };

    it("denies when the owner or the 401 marker was never written (missing mirror)", async () => {
      for (const key of GATE_MIRROR_STORAGE_KEYS) {
        const { wired } = wireWith({ stored: without(key) });
        expect(await wired.gate.allows(null), key).toBe(false);
      }
      const bare = { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) };
      expect(await wireWith({ stored: bare }).wired.gate.allows(null)).toBe(false);
    });

    it("denies on a garbage owner", async () => {
      const { serverOrigin, integrationId } = connectionFor(KEY);
      for (const owner of [
        null,
        "nope",
        7,
        [],
        {},
        { serverOrigin },
        { integrationId },
        { serverOrigin: 1, integrationId },
        { serverOrigin, integrationId: 1 },
      ]) {
        const { wired } = wireWith({ stored: paired({ [GATE_OWNER_STORAGE_KEY]: owner }) });
        expect(await wired.gate.allows(null), JSON.stringify(owner)).toBe(false);
      }
    });

    it("denies on a garbage 401 marker", async () => {
      for (const marker of [
        null,
        undefined,
        "nope",
        7,
        [],
        {},
        { disconnectedFor: undefined },
        { disconnectedFor: 5 },
        { disconnectedFor: "" },
        { disconnectedFor: {} },
      ]) {
        const { wired } = wireWith({ stored: paired({ [GATE_DISCONNECT_STORAGE_KEY]: marker }) });
        expect(await wired.gate.allows(null), JSON.stringify(marker)).toBe(false);
      }
    });

    it("denies when the queue owner does not match the connection (origin, integration, or no owner)", async () => {
      const otherOrigin = connectionFor(KEY, { serverOrigin: ORIGIN_2 });
      const otherIntegration = connectionFor(KEY, { integrationId: INTEGRATION_ID_2 });
      for (const owner of [ownerOf(otherOrigin), ownerOf(otherIntegration), null]) {
        const { wired } = wireWith({ stored: paired({ [GATE_OWNER_STORAGE_KEY]: owner }) });
        expect(await wired.gate.allows(null), JSON.stringify(owner)).toBe(false);
      }
      expect(await wireWith({ stored: paired() }).wired.gate.allows(null)).toBe(true);
    });

    it("denies a mirror that is stale after a re-pair (the connection moved to another owner)", async () => {
      const { wired, stored } = wireWith();
      expect(await wired.gate.allows(null)).toBe(true);
      stored[CONNECTION_STORAGE_KEY] = connectionFor(KEY_2, { serverOrigin: ORIGIN_2 });
      expect(await wired.gate.allows(null)).toBe(false);
    });

    it("denies while the mirrored 401 marker is for this key, and allows a marker of another key", async () => {
      const refused = paired({
        [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: await keyMarker(KEY) },
      });
      expect(await wireWith({ stored: refused }).wired.gate.allows(null)).toBe(false);
      const stale = paired({
        [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: await keyMarker(KEY_2) },
      });
      expect(await wireWith({ stored: stale }).wired.gate.allows(null)).toBe(true);
    });

    it("a 401 writes the marker to the mirror BEFORE it settles the IndexedDB state", async () => {
      const stored = paired();
      let atSettle: unknown = "never settled";
      const { wired, store } = wireWith({
        stored,
        store: (inner) =>
          withOverrides(inner, {
            settle: (update) => {
              if (update.sync?.state === "disconnected") {
                atSettle = stored[GATE_DISCONNECT_STORAGE_KEY];
              }
              return inner.settle(update);
            },
          }),
      });
      await wired.ready;
      await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(1) }));
      world.server.revoke();
      world.connection = connectionFor(KEY);
      await wired.flusher.flush();
      const marker = await keyMarker(KEY);
      expect(atSettle).toEqual({ disconnectedFor: marker });
      expect(stored[GATE_DISCONNECT_STORAGE_KEY]).toEqual({ disconnectedFor: marker });
      expect(await wired.gate.allows(null)).toBe(false);
    });

    it("a 401 whose mirror write fails settles nothing, so the next run asks again", async () => {
      const settledStates: unknown[] = [];
      const { wired, store } = wireWith({
        failSet: (items) =>
          GATE_DISCONNECT_STORAGE_KEY in items && !(GATE_OWNER_STORAGE_KEY in items),
        store: (inner) =>
          withOverrides(inner, {
            settle: (update) => {
              settledStates.push(update.sync?.state);
              return inner.settle(update);
            },
          }),
      });
      await wired.ready;
      await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(1) }));
      const queued = (await store.stats()).depth;
      world.server.revoke();
      world.connection = connectionFor(KEY);
      await expect(wired.flusher.flush()).resolves.toEqual({ status: "backoff" });
      expect(settledStates).not.toContain("disconnected");
      expect((await store.getMeta()).sync.state).toBe("connected");
      expect((await store.stats()).depth).toBe(queued);
    });
  });

  describe("start-up", () => {
    it("an unowned queue takes the paired connection's owner; rows already in it stay unsent", async () => {
      const { wired, store } = wireWith({
        stored: { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) },
      });
      // Rows from before any owner existed (or from a store whose owner was never set).
      await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(2) }));
      expect(await store.getOwner()).toBeNull();

      await wired.ready;
      expect(await store.getOwner()).toEqual(ownerOf(connectionFor(KEY)));

      await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(1, 10) }));
      await wired.flusher.flush();
      const accepted = world.server.acceptedIds();
      expect(accepted).toContain(pageEvents(1, 10)[0]?.id);
      for (const legacy of pageEvents(2)) expect(accepted).not.toContain(legacy.id);
      expect((await store.stats()).depth).toBe(2); // the two unowned rows are still queued
    });

    it("writes the mirror from IndexedDB, so the first capture after a start is allowed", async () => {
      const { wired, stored } = wireWith({
        stored: { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) },
      });
      expect(await wired.gate.allows(null)).toBe(false); // no mirror yet: fail closed
      await wired.ready;
      expect(stored[GATE_OWNER_STORAGE_KEY]).toEqual(ownerOf(connectionFor(KEY)));
      expect(stored[GATE_DISCONNECT_STORAGE_KEY]).toEqual({ disconnectedFor: null });
      expect(await wired.gate.allows(null)).toBe(true);
    });

    it("does not take over a queue that belongs to someone else (the gate keeps denying)", async () => {
      const { wired, store, stored } = wireWith({
        stored: { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) },
      });
      const foreign = ownerOf(connectionFor(KEY_2, { serverOrigin: ORIGIN_2 }));
      await store.setOwner(foreign);
      await wired.ready;
      expect(await store.getOwner()).toEqual(foreign);
      expect(stored[GATE_OWNER_STORAGE_KEY]).toEqual(foreign);
      expect(await wired.gate.allows(null)).toBe(false);
    });

    it("sets no owner without a stored connection", async () => {
      const { wired, store, stored } = wireWith({ stored: {} });
      await wired.ready;
      expect(await store.getOwner()).toBeNull();
      expect(stored[GATE_OWNER_STORAGE_KEY]).toBeNull();
      expect(await wired.gate.allows(null)).toBe(false);
    });

    it("rewrites a stale mirror from the IndexedDB sync state (a kill between the two writes)", async () => {
      // The killed background wrote the sync state but not the mirror. Seeded before the new one
      // is wired, so its start-up cannot read IndexedDB ahead of these writes.
      const dead = world.open();
      await dead.store.setOwner(ownerOf(connectionFor(KEY)));
      const marker = await keyMarker(KEY);
      await dead.store.settle({
        removeSeqs: [],
        sync: { state: "disconnected", disconnectedFor: marker, nextAttemptAt: null },
      });
      world.kill(dead);
      const { wired, stored } = wireWith();
      expect(stored[GATE_DISCONNECT_STORAGE_KEY]).toEqual({ disconnectedFor: null }); // stale
      await wired.ready;
      expect(stored[GATE_DISCONNECT_STORAGE_KEY]).toEqual({ disconnectedFor: marker });
      expect(await wired.gate.allows(null)).toBe(false);
    });

    it("a failing start-up still settles `ready`, and the gate stays closed", async () => {
      const { wired } = wireWith({
        stored: { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) },
        store: (store) =>
          withOverrides(store, {
            getOwner: () => Promise.reject(new Error("indexeddb unavailable")),
            getMeta: () => Promise.reject(new Error("indexeddb unavailable")),
          }),
      });
      await expect(wired.ready).resolves.toBeUndefined();
      expect(await wired.gate.allows(null)).toBe(false);
    });
  });

  it("a flush alarm rewrites the mirror from IndexedDB, healing a stale one", async () => {
    const { wired, stored, listeners } = wire();
    await wired.ready;
    delete stored[GATE_OWNER_STORAGE_KEY];
    const onAlarm = listeners.get("alarms.onAlarm") as ((alarm: { name: string }) => unknown)[];
    const flushListener = onAlarm[1] as (alarm: { name: string }) => Promise<void> | undefined;
    await flushListener({ name: FLUSH_RETRY_ALARM_NAME });
    expect(stored[GATE_OWNER_STORAGE_KEY]).toEqual(ownerOf(connectionFor(KEY)));
  });
});
