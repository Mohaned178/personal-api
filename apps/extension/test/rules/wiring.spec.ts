// M4-06 the background wired with the real rules (no explicit collectGate): what a navigation
// queues, what stays out of the engine's state, and how a rule change reaches capture.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_ALARM_NAME } from "../../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import { PAUSED_STORAGE_KEY } from "../../lib/pause";
import { type BackgroundBrowserApi, wireBackground } from "../../lib/queue";
import { EVENT_CLIENT } from "../../lib/rules/active-rules";
import { RULES_SYNC_ALARM_NAME } from "../../lib/rules/sync";
import { localDate, TODAY_STORAGE_KEY } from "../../lib/today";
import {
  INTEGRATION_ID_2,
  KEY,
  mirrorFor,
  ORIGIN,
  pick,
  tick,
  World,
} from "../queue/support/world";
import { configOf, connectionFor, domainRule, RULES_STORAGE_KEY, storedRules } from "./support";

type AlarmListener = (alarm: { name: string }) => unknown;

function fakeBrowser(
  world: World,
  stored: Record<string, unknown>,
  onGet: (keys: string | string[]) => void = () => undefined,
) {
  const alarmListeners: AlarmListener[] = [];
  const noop = { addListener: () => undefined };
  const browser = {
    tabs: {
      onCreated: noop,
      onUpdated: noop,
      onActivated: noop,
      onRemoved: noop,
      query: async () => [],
      remove: async () => undefined,
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
      onAlarm: { addListener: (listener: AlarmListener) => alarmListeners.push(listener) },
      get: async (name: string) =>
        name === HEARTBEAT_ALARM_NAME || world.alarms.pending.has(name) ? { name } : undefined,
      create: (name: string, info: { when: number } | { periodInMinutes: number }) =>
        world.alarms.create(name, info as { when: number }),
      clear: (name: string) => world.alarms.clear(name),
    },
    runtime: { onStartup: noop, onInstalled: noop },
    storage: {
      session: {
        get: async () => ({ id: "x" }),
        set: async () => undefined,
        remove: async () => undefined,
      },
      local: {
        get: async (keys: string | string[]) => {
          onGet(keys);
          return pick(stored, keys);
        },
        set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete stored[key];
        },
      },
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

const etagFor = (version: number) => `"v${version}"`;

function wire(
  options: {
    stored?: Record<string, unknown>;
    /** What the server answers for the config; defaults to "no such route". */
    config?: () => Response;
    onGet?: (keys: string | string[]) => void;
  } = {},
) {
  const stored: Record<string, unknown> = {
    [CONNECTION_STORAGE_KEY]: connectionFor(KEY),
    ...mirrorFor(),
    ...options.stored,
  };
  const { browser, fire } = fakeBrowser(world, stored, options.onGet);
  const { store } = world.open();
  const configCalls: Record<string, string>[] = [];
  const wired = wireBackground({
    browser,
    store,
    fetch: async (url, init) => {
      if (url === `${ORIGIN}/v1/ingest/config`) {
        configCalls.push(init.headers as Record<string, string>);
        return options.config?.() ?? new Response(null, { status: 404 });
      }
      if (url.endsWith("/v1/ingest/heartbeat")) return new Response(null, { status: 204 });
      return world.server.fetch(url, init);
    },
    now: world.now,
    random: () => 0,
    newId: () => crypto.randomUUID(),
    newTabRef: () => "tabref-aaaa1111",
  });
  return { wired, stored, store, fire, configCalls };
}

const navigate = (
  wired: ReturnType<typeof wire>["wired"],
  url: string,
  options: { tabId?: number; incognito?: boolean } = {},
) =>
  wired.engine.onTabUpdated(
    options.tabId ?? 1,
    { status: "complete" },
    { id: options.tabId ?? 1, url, status: "complete", incognito: options.incognito ?? false },
  );

async function queued(store: ReturnType<typeof wire>["store"]) {
  return (await store.peekBatch()).map((row) => row.event);
}

/** The engine's persisted state as text, to prove a denied page left nothing in it. */
async function stateText(store: ReturnType<typeof wire>["store"]): Promise<string> {
  let text = "";
  await store.transact((prev) => {
    text = JSON.stringify(prev);
    return { state: prev ?? {}, events: [] };
  });
  return text;
}

const github = domainRule("GitHub", "github.com", "allow");
const withRules = (rules = [github], version = 1) => ({
  [RULES_STORAGE_KEY]: storedRules(configOf(rules, { version })),
});

describe("the default gate (no explicit collectGate)", () => {
  const page = (domain: string) => ({ domain, path: "/x" });

  it("allows an allowed domain when connected and not paused, and nothing else", async () => {
    const { wired } = wire({ stored: withRules() });
    expect(await wired.gate.allows(page("github.com"))).toBe(true);
    expect(await wired.gate.allows(page("evil.com"))).toBe(false);
    expect(await wired.gate.allows(page("www.github.com"))).toBe(false);
    expect(await wired.gate.allows(null)).toBe(false);
  });

  it("denies an allowed domain while paused", async () => {
    const { wired } = wire({ stored: { ...withRules(), [PAUSED_STORAGE_KEY]: true } });
    expect(await wired.gate.allows(page("github.com"))).toBe(false);
  });

  it("denies an allowed domain when there is no connection", async () => {
    const { wired, stored } = wire({ stored: withRules() });
    delete stored[CONNECTION_STORAGE_KEY];
    expect(await wired.gate.allows(page("github.com"))).toBe(false);
  });

  it("reads storage.local exactly once per decision (ADR 0002 decision 3), and no IndexedDB", async () => {
    const reads: (string | string[])[] = [];
    const { wired } = wire({ stored: withRules(), onGet: (keys) => void reads.push(keys) });
    reads.length = 0;
    expect(await wired.gate.allows(page("github.com"))).toBe(true);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual(
      expect.arrayContaining([CONNECTION_STORAGE_KEY, PAUSED_STORAGE_KEY, RULES_STORAGE_KEY]),
    );
  });

  it("denies when the storage read throws", async () => {
    let fail = false;
    const { wired } = wire({
      stored: withRules(),
      onGet: () => {
        if (fail) throw new Error("storage unavailable");
      },
    });
    fail = true;
    expect(await wired.gate.allows(page("github.com"))).toBe(false);
  });
});

describe("what a navigation queues", () => {
  it("queues an allowed page, stamped with the rule-set version, query and fragment stripped", async () => {
    const { wired, store } = wire({ stored: withRules([github], 5) });
    await navigate(wired, "https://github.com/org/repo?secret=1#frag");
    const [event] = await queued(store);
    expect(event?.type).toBe("browser.page_visited");
    expect(event?.data).toMatchObject({ domain: "github.com", path: "/org/repo" });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event?.meta).toEqual({ ruleSetVersion: 5, client: EVENT_CLIENT });
  });

  it("queues nothing for a page no rule allows, and the page never reaches the engine's state", async () => {
    const { wired, store } = wire({ stored: withRules() });
    await navigate(wired, "https://denied-site.example/very/private");
    expect(await queued(store)).toEqual([]);
    const state = await stateText(store);
    expect(state).not.toContain("denied-site.example");
    expect(state).not.toContain("very/private");
  });

  it("applies a coarsen rule to what is queued", async () => {
    const coarse = domainRule("Coarse", "github.com", "allow", {
      then: [{ action: "allow" }, { action: "coarsen", segments: 1 }],
    });
    const { wired, store } = wire({ stored: withRules([coarse]) });
    await navigate(wired, "https://github.com/org/repo/issues/1");
    expect((await queued(store))[0]?.data).toMatchObject({ path: "/org" });
  });

  it("queues nothing in a private window, whatever the rules say", async () => {
    const { wired, store } = wire({ stored: withRules() });
    await navigate(wired, "https://github.com/", { incognito: true });
    expect(await queued(store)).toEqual([]);
  });

  it.each([
    ["no rules stored", {}],
    [
      "rules fetched for another integration",
      {
        [RULES_STORAGE_KEY]: storedRules(configOf([github]), {
          connection: connectionFor(KEY, { integrationId: INTEGRATION_ID_2 }),
        }),
      },
    ],
    ["rules that do not validate", { [RULES_STORAGE_KEY]: { owner: 1 } }],
  ])("queues nothing with %s (fail closed)", async (_label, stored) => {
    const { wired, store } = wire({ stored });
    await navigate(wired, "https://github.com/");
    expect(await queued(store)).toEqual([]);
    expect(await wired.gate.allows({ domain: "github.com", path: "/" })).toBe(false);
  });
});

describe("rule sync in the background", () => {
  const served =
    (rules = [github], version = 1) =>
    () =>
      new Response(JSON.stringify(configOf(rules, { version })), {
        status: 200,
        headers: { etag: etagFor(version) },
      });

  it("fetches the rules at start, arms the periodic alarm, and then captures", async () => {
    const { wired, store, configCalls } = wire({ config: served() });
    expect(await wired.gate.allows({ domain: "github.com", path: "/" })).toBe(false);
    await wired.ready;
    expect(configCalls).toHaveLength(1);
    expect(world.alarms.pending.has(RULES_SYNC_ALARM_NAME)).toBe(true);
    await navigate(wired, "https://github.com/");
    expect(await queued(store)).toHaveLength(1);
  });

  it("a rule change reaches capture at the next alarm: later events behave differently", async () => {
    let current = served([github], 1);
    const { wired, store, fire, configCalls } = wire({ config: () => current() });
    await wired.ready;
    await navigate(wired, "https://github.com/a", { tabId: 1 });
    expect(await queued(store)).toHaveLength(1);

    const drop = domainRule("Stop GitHub", "github.com", "drop", { priority: 1 });
    current = served([github, drop], 2);
    await fire(RULES_SYNC_ALARM_NAME);
    expect(configCalls.at(-1)?.["if-none-match"]).toBe(etagFor(1));

    await navigate(wired, "https://github.com/b", { tabId: 2 });
    expect(await queued(store)).toHaveLength(1);
  });

  it("an unchanged config (304) keeps capturing", async () => {
    let calls = 0;
    const { wired, store, fire } = wire({
      config: () => (++calls === 1 ? served()() : new Response(null, { status: 304 })),
    });
    await wired.ready;
    await fire(RULES_SYNC_ALARM_NAME);
    await navigate(wired, "https://github.com/");
    expect(await queued(store)).toHaveLength(1);
  });

  it("a server that refuses the key (401) stops capture until valid rules arrive", async () => {
    let answer: () => Response = served();
    const { wired, store, fire } = wire({ config: () => answer() });
    await wired.ready;
    answer = () => new Response(null, { status: 401 });
    await fire(RULES_SYNC_ALARM_NAME);
    await navigate(wired, "https://github.com/", { tabId: 1 });
    expect(await queued(store)).toEqual([]);

    answer = served();
    await fire(RULES_SYNC_ALARM_NAME);
    await navigate(wired, "https://github.com/", { tabId: 2 });
    expect(await queued(store)).toHaveLength(1);
  });

  it("a network failure keeps the last valid rules", async () => {
    const { wired, store, fire } = wire({
      stored: withRules(),
      config: () => new Response(null, { status: 503 }),
    });
    await wired.ready;
    await fire(RULES_SYNC_ALARM_NAME);
    await navigate(wired, "https://github.com/");
    expect(await queued(store)).toHaveLength(1);
  });

  it("events queued under rules are still sent after the flush", async () => {
    const { wired, store } = wire({
      stored: withRules([github], 4),
      config: () =>
        new Response(JSON.stringify(configOf([github], { version: 4 })), {
          status: 200,
          headers: { etag: etagFor(4) },
        }),
    });
    await wired.ready;
    await navigate(wired, "https://github.com/");
    await tick();
    await wired.flusher.flush();
    expect(world.server.acceptedIds()).toHaveLength(1);
    expect((await store.stats()).depth).toBe(0);
  });
});

describe("the server's own origin (M8-01)", () => {
  const allowAll = () => withRules([{ ...domainRule("Everything", "x.com", "allow"), when: {} }]);

  it("never captures a page on the server's origin, even when a rule allows everything", async () => {
    const { wired, store } = wire({ stored: allowAll() });
    // The rules allow this host on any other origin: only the exclusion keeps the server out.
    expect(await wired.gate.allows({ domain: new URL(ORIGIN).hostname, path: "/rules" })).toBe(
      true,
    );
    await navigate(wired, `${ORIGIN}/connect-extension/done#code=ABCD-EFGH`, { tabId: 3 });
    await navigate(wired, `${ORIGIN}/rules`, { tabId: 4 });
    const host = new URL(ORIGIN).hostname;
    expect((await queued(store)).filter((e) => JSON.stringify(e).includes(host))).toEqual([]);
    expect(await stateText(store)).not.toContain(host);
  });

  it("still captures the same host on another port or scheme (only the exact origin is skipped)", async () => {
    const { wired, store } = wire({ stored: allowAll() });
    const host = new URL(ORIGIN).hostname;
    await navigate(wired, `https://${host}:8443/app`, { tabId: 5 });
    const visits = (await queued(store)).filter((e) => e.type === "browser.page_visited");
    expect(visits.map((e) => e.data)).toContainEqual(
      expect.objectContaining({ domain: host, path: "/app" }),
    );
  });
});

describe("the popup's Today (M8-04)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("deletes yesterday's entry at background start", async () => {
    const yesterday = { date: localDate(world.now() - DAY), ms: { "github.com": 1000 } };
    const { wired, stored } = wire({ stored: { [TODAY_STORAGE_KEY]: yesterday } });
    await wired.ready;
    expect(stored).not.toHaveProperty(TODAY_STORAGE_KEY);
  });

  it("keeps today's entry at start, and deletes it on the first alarm after midnight", async () => {
    const today = { date: localDate(world.now()), ms: { "github.com": 1000 } };
    const { wired, stored, fire } = wire({ stored: { [TODAY_STORAGE_KEY]: today } });
    await wired.ready;
    expect(stored[TODAY_STORAGE_KEY]).toEqual(today);
    world.clock += DAY;
    await fire(HEARTBEAT_ALARM_NAME);
    await tick();
    expect(stored).not.toHaveProperty(TODAY_STORAGE_KEY);
  });
});
