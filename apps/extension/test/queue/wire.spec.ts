// M2-05 background wiring: listeners at the top level, a gate that fails closed, flush alarms.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_ALARM_NAME } from "../../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import { type BackgroundBrowserApi, FLUSH_RETRY_ALARM_NAME, wireBackground } from "../../lib/queue";
import { connectionFor, KEY, pageEvents, World } from "./support/world";

type Listener = (...args: never[]) => unknown;

function fakeBrowser(world: World, stored: Record<string, unknown>) {
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
      session: { get: async () => ({ id: "x" }), set: async () => undefined },
      local: { get: async (key: string) => ({ [key]: stored[key] }) },
    },
  } satisfies BackgroundBrowserApi;
  return { browser, listeners };
}

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

function wire(options: { allow?: boolean | null; connected?: boolean } = {}) {
  const stored: Record<string, unknown> =
    options.connected === false ? {} : { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) };
  const { browser, listeners } = fakeBrowser(world, stored);
  const { store } = world.open();
  const wired = wireBackground({
    browser,
    store,
    fetch: world.server.fetch,
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
    for (const name of [
      "tabs.onCreated",
      "tabs.onUpdated",
      "tabs.onActivated",
      "tabs.onRemoved",
      "windows.onFocusChanged",
      "idle.onStateChanged",
      "runtime.onStartup",
      "runtime.onInstalled",
    ]) {
      expect(listeners.get(name), name).toHaveLength(1);
    }
    expect(listeners.get("alarms.onAlarm")).toHaveLength(2);
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
      browser: fakeBrowser(world, { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) }).browser,
      store: notTrue.store,
      fetch: world.server.fetch,
      now: world.now,
      random: () => 0,
      newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
      newTabRef: () => "tabref-aaaa1111",
      collectGate: { allows: (() => "yes") as never },
    });
    expect(await odd.gate.allows(null)).toBe(false);

    const throwing = wireBackground({
      browser: fakeBrowser(world, { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) }).browser,
      store: notTrue.store,
      fetch: world.server.fetch,
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
