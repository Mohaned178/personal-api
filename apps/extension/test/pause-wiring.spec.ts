// M2-06 background wiring: pause closes the capture gate (fail closed), the server heartbeat is
// armed on start and sent from its alarm. Uses the M2-05 World and the same fake browser shape as
// test/queue/wire.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_ALARM_NAME } from "../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../lib/connect";
import { SERVER_HEARTBEAT_ALARM_NAME } from "../lib/heartbeat";
import { PAUSED_STORAGE_KEY } from "../lib/pause";
import { type BackgroundBrowserApi, wireBackground } from "../lib/queue";
import { connectionFor, KEY, ORIGIN, ownerOf, pageEvents, World } from "./queue/support/world";

type Listener = (alarm: { name: string }) => unknown;

function fakeBrowser(world: World, stored: Record<string, unknown>) {
  const alarmListeners: Listener[] = [];
  const noop = { addListener: () => undefined };
  const browser = {
    tabs: {
      onCreated: noop,
      onUpdated: noop,
      onActivated: noop,
      onRemoved: noop,
      query: async () => [],
    },
    windows: {
      onFocusChanged: noop,
      getLastFocused: async () => ({ focused: false, incognito: false }),
    },
    idle: {
      onStateChanged: noop,
      queryState: async () => "active" as const,
      setDetectionInterval: () => undefined,
    },
    alarms: {
      onAlarm: { addListener: (listener: Listener) => alarmListeners.push(listener) },
      // The capture heartbeat alarm "exists"; anything else does not until created.
      get: async (name: string) =>
        name === HEARTBEAT_ALARM_NAME || world.alarms.pending.has(name) ? { name } : undefined,
      create: (name: string, info: { when: number } | { periodInMinutes: number }) =>
        world.alarms.create(name, info as { when: number }),
      clear: (name: string) => world.alarms.clear(name),
    },
    runtime: { onStartup: noop, onInstalled: noop },
    storage: {
      session: { get: async () => ({ id: "x" }), set: async () => undefined },
      local: { get: async (key: string) => ({ [key]: stored[key] }) },
    },
  } satisfies BackgroundBrowserApi;
  const fire = (name: string) => Promise.all(alarmListeners.map((l) => l({ name })));
  return { browser, fire };
}

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

function wire(options: { connected?: boolean; stored?: Record<string, unknown> } = {}) {
  const stored: Record<string, unknown> = {
    ...(options.connected === false ? {} : { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) }),
    ...options.stored,
  };
  const { browser, fire } = fakeBrowser(world, stored);
  const { store, flusher } = world.open();
  const urls: string[] = [];
  const wired = wireBackground({
    browser,
    store,
    fetch: async (url, init) => {
      urls.push(url);
      if (url.endsWith("/v1/ingest/heartbeat")) return new Response(null, { status: 204 });
      return world.server.fetch(url, init);
    },
    now: world.now,
    random: () => 0,
    newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
    newTabRef: () => "tabref-aaaa1111",
    collectGate: { allows: () => true },
  });
  return { wired, fire, stored, store, flusher, urls };
}

describe("pause closes the capture gate", () => {
  it("allows while not paused, denies while paused, allows again after resume", async () => {
    const { wired, stored } = wire();
    expect(await wired.gate.allows(null)).toBe(true);
    stored[PAUSED_STORAGE_KEY] = true;
    expect(await wired.gate.allows(null)).toBe(false);
    expect(await wired.gate.allows({ domain: "a.example", path: "/" })).toBe(false);
    stored[PAUSED_STORAGE_KEY] = false;
    expect(await wired.gate.allows(null)).toBe(true);
  });

  it("a pause flag that is garbage denies (fail closed)", async () => {
    const { wired } = wire({ stored: { [PAUSED_STORAGE_KEY]: "yes" } });
    expect(await wired.gate.allows(null)).toBe(false);
  });

  it("a paused background starts with the gate already closed", async () => {
    const { wired } = wire({ stored: { [PAUSED_STORAGE_KEY]: true } });
    await wired.ready;
    expect(await wired.gate.allows(null)).toBe(false);
  });

  it("pause does not stop syncing what is already queued", async () => {
    const { wired, store } = wire({ stored: { [PAUSED_STORAGE_KEY]: true } });
    await store.setOwner(ownerOf(connectionFor(KEY))); // events are queued for the paired owner
    await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(2) }));
    await wired.flusher.flush();
    expect((await store.stats()).depth).toBe(0);
    for (const event of pageEvents(2)) expect(world.server.acceptedIds()).toContain(event.id);
  });
});

describe("server heartbeat wiring", () => {
  it("ready arms the periodic server heartbeat alarm", async () => {
    const { wired } = wire();
    await wired.ready;
    expect(world.alarms.pending.has(SERVER_HEARTBEAT_ALARM_NAME)).toBe(true);
  });

  it("the alarm sends one heartbeat to the connected server", async () => {
    const { fire, urls } = wire();
    await fire(SERVER_HEARTBEAT_ALARM_NAME);
    expect(urls.filter((url) => url === `${ORIGIN}/v1/ingest/heartbeat`)).toHaveLength(1);
  });

  it("the alarm still sends while capture is paused", async () => {
    const { fire, urls } = wire({ stored: { [PAUSED_STORAGE_KEY]: true } });
    await fire(SERVER_HEARTBEAT_ALARM_NAME);
    expect(urls.some((url) => url.endsWith("/v1/ingest/heartbeat"))).toBe(true);
  });

  it("sends nothing when there is no stored connection", async () => {
    const { fire, urls } = wire({ connected: false });
    await fire(SERVER_HEARTBEAT_ALARM_NAME);
    expect(urls).toEqual([]);
  });

  it("the capture alarm runs the flush but does not send the server heartbeat", async () => {
    const { fire, store, urls } = wire();
    await store.setOwner(ownerOf(connectionFor(KEY))); // events are queued for the paired owner
    await store.transact((prev) => ({ state: prev ?? {}, events: pageEvents(1) }));
    await fire(HEARTBEAT_ALARM_NAME);
    expect(urls.some((url) => url.endsWith("/v1/ingest/events"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/v1/ingest/heartbeat"))).toBe(false);
  });
});
