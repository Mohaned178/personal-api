// M2-06 server heartbeat sender (lib/heartbeat.ts): alarm-driven POST /v1/ingest/heartbeat.
// The body itself is pinned by test/queue/heartbeat.spec.ts (buildHeartbeat).

import { heartbeatRequestSchema } from "@personal-api/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_ALARM_NAME } from "../lib/capture";
import {
  createHeartbeatSender,
  SERVER_HEARTBEAT_ALARM_NAME,
  SERVER_HEARTBEAT_PERIOD_MINUTES,
} from "../lib/heartbeat";
import { FLUSH_RETRY_ALARM_NAME } from "../lib/queue";
import {
  KEY,
  ORIGIN,
  pageEvents,
  SECRET_DOMAIN,
  spyOnConsole,
  T0,
  World,
  withOverrides,
} from "./queue/support/world";

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: unknown;
}

function setup(
  respond: () => Promise<Response> | Response = () => new Response(null, { status: 204 }),
) {
  const calls: Call[] = [];
  const created: { name: string; info: { periodInMinutes: number } }[] = [];
  const existing = new Set<string>();
  const inst = world.open();
  const sender = (overrides: Partial<Parameters<typeof createHeartbeatSender>[0]> = {}) =>
    createHeartbeatSender({
      store: inst.store,
      getConnection: async () => (world.connection ? { ...world.connection } : null),
      fetch: async (url, init) => {
        calls.push({
          url,
          init,
          headers: new Headers(init.headers),
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return respond();
      },
      alarms: {
        get: async (name) => (existing.has(name) ? { name } : undefined),
        create: (name, info) => {
          created.push({ name, info });
          existing.add(name);
        },
      },
      now: world.now,
      clientVersion: "0.1.0",
      ...overrides,
    });
  return { inst, calls, created, existing, sender };
}

describe("heartbeat sender: send", () => {
  it("POSTs to the connected server with the ingest key and a contract-valid body", async () => {
    const { calls, sender, inst } = setup();
    await world.enqueue(inst, pageEvents(3));
    world.clock = T0 + 10_000;
    expect(await sender().send()).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe(`${ORIGIN}/v1/ingest/heartbeat`);
    expect(call.init.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.init.credentials).toBe("omit");
    expect(heartbeatRequestSchema.safeParse(call.body).success).toBe(true);
    expect(call.body).toEqual({
      queueDepth: 3,
      oldestQueuedAgeMs: 10_000,
      droppedCount: 0,
      clientVersion: "0.1.0",
    });
  });

  it("reports the local drop counter so an overflow is never silent", async () => {
    const small = world.open({ maxEvents: 2 });
    const { calls, sender } = setup();
    await world.enqueue(small, pageEvents(5));
    await sender({ store: small.store }).send();
    expect(calls[0]?.body).toMatchObject({ queueDepth: 2, droppedCount: 3 });
  });

  it("sends nothing and says so when there is no connection (fail closed)", async () => {
    world.connection = null;
    const { calls, sender } = setup();
    expect(await sender().send()).toEqual({ status: "not_connected" });
    expect(calls).toHaveLength(0);
  });

  it("sends nothing while the ingest key was refused (disconnected)", async () => {
    const { calls, sender, inst } = setup();
    await world.enqueue(inst, pageEvents(1));
    world.server.revoke();
    await inst.flusher.flush();
    expect(await sender().send()).toEqual({ status: "disconnected" });
    expect(calls).toHaveLength(0);
  });

  it("still sends while capture is paused (pause stops capture, not the heartbeat)", async () => {
    // Pause lives in storage and is not an input of the sender at all.
    const { calls, sender } = setup();
    await sender().send();
    expect(calls).toHaveLength(1);
  });

  it("never rejects: a network error, a 401 and a 500 all answer failed", async () => {
    for (const respond of [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 500 }),
    ]) {
      const { sender } = setup(respond);
      expect(await sender().send()).toEqual({ status: "failed" });
    }
  });

  it("never rejects when the connection or the store throws, and sends nothing", async () => {
    const { calls, sender, inst } = setup();
    expect(
      await sender({
        getConnection: async () => {
          throw new Error("storage");
        },
      }).send(),
    ).not.toEqual({ status: "sent" });
    const broken = withOverrides(inst.store, {
      stats: async () => {
        throw new Error("idb down");
      },
    });
    expect(await sender({ store: broken }).send()).toEqual({ status: "failed" });
    expect(calls).toHaveLength(0);
  });

  it("a failed heartbeat does not touch the queue or the sync state", async () => {
    const { sender, inst } = setup(() => new Response("{}", { status: 401 }));
    await world.enqueue(inst, pageEvents(2));
    const before = await inst.store.getMeta();
    await sender().send();
    expect((await inst.store.stats()).depth).toBe(2);
    expect((await inst.store.getMeta()).sync).toEqual(before.sync);
  });

  it("never logs and never puts event data in the request (invariant 6)", async () => {
    const spy = spyOnConsole();
    try {
      const { calls, sender, inst } = setup(() => new Response("{}", { status: 500 }));
      await world.enqueue(inst, pageEvents(2));
      await sender().send();
      expect(JSON.stringify(calls[0]?.body)).not.toContain(SECRET_DOMAIN);
      expect(calls[0]?.url).not.toContain(SECRET_DOMAIN);
      spy.expectSilent();
    } finally {
      spy.restore();
    }
  });
});

describe("heartbeat sender: alarm", () => {
  it("uses an alarm of its own, distinct from the capture and flush alarms", () => {
    expect(SERVER_HEARTBEAT_ALARM_NAME).not.toBe(HEARTBEAT_ALARM_NAME);
    expect(SERVER_HEARTBEAT_ALARM_NAME).not.toBe(FLUSH_RETRY_ALARM_NAME);
    expect(SERVER_HEARTBEAT_PERIOD_MINUTES).toBeGreaterThanOrEqual(1);
    expect(SERVER_HEARTBEAT_PERIOD_MINUTES).toBeLessThanOrEqual(15);
  });

  it("start creates the periodic alarm once, and not again when it already exists", async () => {
    const { created, sender } = setup();
    const first = sender();
    await first.start();
    expect(created).toEqual([
      {
        name: SERVER_HEARTBEAT_ALARM_NAME,
        info: { periodInMinutes: SERVER_HEARTBEAT_PERIOD_MINUTES },
      },
    ]);
    await sender().start(); // a restarted background sees the existing alarm
    expect(created).toHaveLength(1);
  });

  it("start never rejects when the alarms API throws", async () => {
    const { sender } = setup();
    await expect(
      sender({
        alarms: {
          get: async () => {
            throw new Error("alarms");
          },
          create: () => {
            throw new Error("alarms");
          },
        },
      }).start(),
    ).resolves.toBeUndefined();
  });

  it("the alarm triggers one heartbeat", async () => {
    const { calls, sender } = setup();
    const pending = sender().onAlarm({ name: SERVER_HEARTBEAT_ALARM_NAME });
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(calls).toHaveLength(1);
  });

  it("other alarms are ignored (undefined, nothing sent)", () => {
    const { calls, sender } = setup();
    const s = sender();
    expect(s.onAlarm({ name: HEARTBEAT_ALARM_NAME })).toBeUndefined();
    expect(s.onAlarm({ name: FLUSH_RETRY_ALARM_NAME })).toBeUndefined();
    expect(s.onAlarm({ name: "something-else" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("the alarm promise never rejects", async () => {
    const { sender } = setup(() => Promise.reject(new TypeError("fetch failed")));
    await expect(sender().onAlarm({ name: SERVER_HEARTBEAT_ALARM_NAME })).resolves.toBeUndefined();
  });
});
