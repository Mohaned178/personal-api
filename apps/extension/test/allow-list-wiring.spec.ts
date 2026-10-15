// M2-07: with no explicit collectGate, wireBackground gates capture on the stored allow list.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOW_LIST_STORAGE_KEY } from "../lib/allow-list";
import { CONNECTION_STORAGE_KEY } from "../lib/connect";
import { PAUSED_STORAGE_KEY } from "../lib/pause";
import { type BackgroundBrowserApi, wireBackground } from "../lib/queue";
import { connectionFor, KEY, World } from "./queue/support/world";

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

function wire(stored: Record<string, unknown>, connected = true) {
  const noop = { addListener: () => undefined };
  const all: Record<string, unknown> = {
    ...(connected ? { [CONNECTION_STORAGE_KEY]: connectionFor(KEY) } : {}),
    ...stored,
  };
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
      onAlarm: noop,
      get: async () => undefined,
      create: (n: string, i: { when: number } | { periodInMinutes: number }) =>
        world.alarms.create(n, i as { when: number }),
      clear: (n: string) => world.alarms.clear(n),
    },
    runtime: { onStartup: noop, onInstalled: noop },
    storage: {
      session: { get: async () => ({ id: "x" }), set: async () => undefined },
      local: { get: async (key: string) => ({ [key]: all[key] }) },
    },
  } satisfies BackgroundBrowserApi;
  const { store } = world.open();
  return wireBackground({
    browser,
    store,
    fetch: (url, init) => world.server.fetch(url, init),
    now: world.now,
    random: () => 0,
    newId: () => "0192f1c2-7c1e-7a3b-9f00-000000000001",
    newTabRef: () => "tabref-aaaa1111",
  });
}
const page = (domain: string) => ({ domain, path: "/x" });

describe("capture gate uses the allow list", () => {
  it("denies everything with a missing list", async () => {
    expect(await wire({}).gate.allows(page("example.com"))).toBe(false);
  });
  it("allows a listed domain when connected and not paused", async () => {
    const w = wire({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"] });
    expect(await w.gate.allows(page("example.com"))).toBe(true);
  });
  it("denies a non-listed domain, a subdomain and a null page", async () => {
    const w = wire({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"] });
    expect(await w.gate.allows(page("evil.com"))).toBe(false);
    expect(await w.gate.allows(page("www.example.com"))).toBe(false);
    expect(await w.gate.allows(null)).toBe(false);
  });
  it("a listed domain is still denied while paused", async () => {
    const w = wire({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"], [PAUSED_STORAGE_KEY]: true });
    expect(await w.gate.allows(page("example.com"))).toBe(false);
  });
  it("a listed domain is still denied when not connected", async () => {
    const w = wire({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"] }, false);
    expect(await w.gate.allows(page("example.com"))).toBe(false);
  });
  it("a corrupt list denies everything", async () => {
    const w = wire({ [ALLOW_LIST_STORAGE_KEY]: "example.com" });
    expect(await w.gate.allows(page("example.com"))).toBe(false);
  });
});
