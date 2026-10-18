// M4-06 rules sync: GET /v1/ingest/config with an ETag. Fail closed: rules that do not validate or
// that the server refuses to give are removed; a flaky network keeps the last valid rules.

import { describe, expect, it } from "vitest";
import type { Connection } from "../../lib/connect";
import { parseStoredRules } from "../../lib/rules/active-rules";
import {
  createRulesSync,
  RULES_SYNC_ALARM_NAME,
  RULES_SYNC_PERIOD_MINUTES,
} from "../../lib/rules/sync";
import { INTEGRATION_ID_2, KEY, KEY_2, ORIGIN } from "../queue/support/world";
import {
  configOf,
  connectionFor,
  domainRule,
  memoryStorage,
  RULES_STORAGE_KEY,
  storedRules,
} from "./support";

const config = configOf([domainRule("GitHub", "github.com", "allow")], { version: 3 });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"v3"', ...init.headers },
    ...init,
  });

interface Call {
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}

function setup(
  options: {
    connection?: Connection | null | (() => Connection | null);
    stored?: Record<string, unknown>;
    respond?: (call: Call) => Response | Promise<Response>;
  } = {},
) {
  const storage = memoryStorage(options.stored);
  const calls: Call[] = [];
  const alarms = new Map<string, { periodInMinutes: number }>();
  const getConnection = async () =>
    typeof options.connection === "function"
      ? options.connection()
      : options.connection === undefined
        ? connectionFor()
        : options.connection;
  const sync = createRulesSync({
    getConnection,
    storage,
    fetch: async (url, init) => {
      const call = { url, headers: init.headers as Record<string, string>, init };
      calls.push(call);
      if (options.respond === undefined) throw new Error("unexpected request");
      return options.respond(call);
    },
    alarms: {
      get: async (name) => alarms.get(name),
      create: (name, info) => void alarms.set(name, info),
    },
  });
  return { sync, storage, calls, alarms };
}

const storedConfig = (storage: { stored: Record<string, unknown> }) =>
  parseStoredRules(storage.stored[RULES_STORAGE_KEY]);

describe("the request", () => {
  it("is a credential-less GET to the connection's origin with the ingest key", async () => {
    const t = setup({ respond: () => json(config) });
    await t.sync.sync();
    const [call] = t.calls;
    expect(call?.url).toBe(`${ORIGIN}/v1/ingest/config`);
    expect(call?.init.method).toBe("GET");
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.cache).toBe("no-store");
    expect(call?.headers["if-none-match"]).toBeUndefined();
  });

  it("sends the stored ETag back, only for rules that are valid and belong to this connection", async () => {
    const t = setup({
      stored: { [RULES_STORAGE_KEY]: storedRules(config, { etag: '"v3"' }) },
      respond: () => new Response(null, { status: 304 }),
    });
    expect(await t.sync.sync()).toBe("unchanged");
    expect(t.calls[0]?.headers["if-none-match"]).toBe('"v3"');
  });

  it.each([
    [
      "rules of another integration",
      () => ({
        [RULES_STORAGE_KEY]: storedRules(config, {
          connection: connectionFor(KEY, { integrationId: INTEGRATION_ID_2 }),
        }),
      }),
    ],
    ["rules that do not validate", () => ({ [RULES_STORAGE_KEY]: { owner: 1, etag: '"v3"' } })],
  ])("does not send an ETag for %s", async (_label, stored) => {
    const t = setup({ stored: stored(), respond: () => json(config) });
    await t.sync.sync();
    expect(t.calls[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("makes no request without a connection", async () => {
    const t = setup({ connection: null });
    expect(await t.sync.sync()).toBe("not_connected");
    expect(t.calls).toEqual([]);
  });
});

describe("a valid answer", () => {
  it("is stored with its ETag and the owner it was fetched for", async () => {
    const t = setup({ respond: () => json(config) });
    expect(await t.sync.sync()).toBe("updated");
    const stored = storedConfig(t.storage);
    expect(stored?.etag).toBe('"v3"');
    expect(stored?.owner).toEqual({
      serverOrigin: ORIGIN,
      integrationId: connectionFor().integrationId,
    });
    expect(stored?.config).toEqual(config);
  });

  it("replaces older rules", async () => {
    const t = setup({
      stored: { [RULES_STORAGE_KEY]: storedRules(configOf([], { version: 1 }), { etag: '"v1"' }) },
      respond: () => json(config),
    });
    expect(await t.sync.sync()).toBe("updated");
    expect(storedConfig(t.storage)?.config.ruleSetVersion).toBe(3);
  });

  it("is stored with an empty ETag when the server sends none, and then asked for again in full", async () => {
    const t = setup({
      respond: () => new Response(JSON.stringify(config), { status: 200 }),
    });
    await t.sync.sync();
    expect(storedConfig(t.storage)?.etag).toBe("");
    await t.sync.sync();
    expect(t.calls[1]?.headers["if-none-match"]).toBeUndefined();
  });

  it("is dropped when the connection changed while the request was out", async () => {
    let reads = 0;
    const t = setup({
      connection: () =>
        ++reads === 1 ? connectionFor() : connectionFor(KEY_2, { integrationId: INTEGRATION_ID_2 }),
      respond: () => json(config),
    });
    expect(await t.sync.sync()).toBe("failed");
    expect(t.storage.stored[RULES_STORAGE_KEY]).toBeUndefined();
  });
});

describe("rules that cannot be used remove the stored rules (fail closed)", () => {
  const existing = () => ({ [RULES_STORAGE_KEY]: storedRules(config, { etag: '"old"' }) });

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["not the contract", () => json({ rules: "all" })],
    ["a config with an unknown key", () => json({ ...config, extra: true })],
    [
      "a process rule",
      () =>
        json({
          ...config,
          rules: [{ ...config.rules[0], stage: "process", then: [{ action: "tag", tag: "x" }] }],
        }),
    ],
    [
      "a rule set the engine refuses (duplicate id)",
      () => json({ ...config, rules: [config.rules[0], config.rules[0]] }),
    ],
  ])("a 200 with %s", async (_label, respond) => {
    const t = setup({ stored: existing(), respond });
    expect(await t.sync.sync()).toBe("cleared");
    expect(t.storage.stored[RULES_STORAGE_KEY]).toBeUndefined();
  });

  it.each([400, 401, 403, 404, 409, 410])("a %i", async (status) => {
    const t = setup({ stored: existing(), respond: () => new Response(null, { status }) });
    expect(await t.sync.sync()).toBe("cleared");
    expect(t.storage.stored[RULES_STORAGE_KEY]).toBeUndefined();
  });

  it("a 304 when no valid rules were sent along (nothing to keep)", async () => {
    const t = setup({ respond: () => new Response(null, { status: 304 }) });
    expect(await t.sync.sync()).toBe("cleared");
  });
});

describe("a failure to reach the server keeps the last valid rules", () => {
  const existing = () => ({ [RULES_STORAGE_KEY]: storedRules(config, { etag: '"old"' }) });

  it.each([408, 425, 429, 500, 502, 503])("a %i", async (status) => {
    const t = setup({ stored: existing(), respond: () => new Response(null, { status }) });
    expect(await t.sync.sync()).toBe("failed");
    expect(storedConfig(t.storage)?.etag).toBe('"old"');
  });

  it("a network error", async () => {
    const t = setup({
      stored: existing(),
      respond: () => {
        throw new TypeError("network down");
      },
    });
    expect(await t.sync.sync()).toBe("failed");
    expect(storedConfig(t.storage)?.etag).toBe('"old"');
  });

  it("a storage failure while saving (nothing half-written, never rejects)", async () => {
    const t = setup({ respond: () => json(config) });
    t.storage.set = async () => {
      throw new Error("quota");
    };
    // createRulesSync captured the object, so rebuild with the failing storage.
    const failing = createRulesSync({
      getConnection: async () => connectionFor(),
      storage: { ...t.storage, set: t.storage.set },
      fetch: async () => json(config),
      alarms: { get: async () => undefined, create: () => undefined },
    });
    expect(await failing.sync()).toBe("failed");
    expect(t.storage.stored[RULES_STORAGE_KEY]).toBeUndefined();
  });
});

describe("calls do not overlap", () => {
  it("runs one after another and the later call sees the earlier call's rules", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let peak = 0;
    const t = setup({
      respond: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight -= 1;
        return json(config);
      },
    });
    const first = t.sync.sync();
    const second = t.sync.sync();
    release();
    expect(await first).toBe("updated");
    expect(await second).toBe("updated");
    expect(peak).toBe(1);
    expect(t.calls[1]?.headers["if-none-match"]).toBe('"v3"');
  });
});

describe("the alarm", () => {
  it("is created once, periodic, when the background starts, and start syncs", async () => {
    const t = setup({ respond: () => json(config) });
    await t.sync.start();
    expect(t.alarms.get(RULES_SYNC_ALARM_NAME)).toEqual({
      periodInMinutes: RULES_SYNC_PERIOD_MINUTES,
    });
    expect(t.calls).toHaveLength(1);
    expect(storedConfig(t.storage)?.config.ruleSetVersion).toBe(3);
  });

  it("is not recreated when it exists (restarts do not push the next tick back)", async () => {
    const t = setup({ respond: () => json(config) });
    t.alarms.set(RULES_SYNC_ALARM_NAME, { periodInMinutes: 99 });
    await t.sync.start();
    expect(t.alarms.get(RULES_SYNC_ALARM_NAME)?.periodInMinutes).toBe(99);
  });

  it("start never rejects, even when the alarms API fails", async () => {
    const sync = createRulesSync({
      getConnection: async () => null,
      storage: memoryStorage(),
      fetch: async () => json(config),
      alarms: {
        get: async () => {
          throw new Error("alarms unavailable");
        },
        create: () => undefined,
      },
    });
    await expect(sync.start()).resolves.toBeUndefined();
  });

  it("onAlarm syncs for its own alarm and returns the promise (Firefox), nothing for others", async () => {
    const t = setup({ respond: () => json(config) });
    const work = t.sync.onAlarm({ name: RULES_SYNC_ALARM_NAME });
    expect(work).toBeInstanceOf(Promise);
    await work;
    expect(t.calls).toHaveLength(1);
    expect(t.sync.onAlarm({ name: "pa-heartbeat" })).toBeUndefined();
    expect(t.calls).toHaveLength(1);
  });
});
