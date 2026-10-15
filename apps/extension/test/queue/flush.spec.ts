// M2-05 (3) the batch flush: request shape, per-item results, failures and backoff, 401 and the
// disconnected state, whole-request 4xx, single-flight, and (8) silence (no logs, no leaked key).

import {
  INGEST_ERROR_CODES,
  INGEST_MAX_BATCH_BYTES,
  ingestBatchRequestSchema,
  parseEvent,
} from "@personal-api/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedEvent } from "../../lib/capture";
import { HEARTBEAT_ALARM_NAME } from "../../lib/capture";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  createFlusher,
  FLUSH_RETRY_ALARM_NAME,
  RETRY_AFTER_MAX_MS,
} from "../../lib/queue";
import {
  bigEvent,
  connectionFor,
  expectBatchesValid,
  INTEGRATION_ID_2,
  type Instance,
  KEY,
  KEY_2,
  ORIGIN,
  ORIGIN_2,
  ownerOf,
  pageEvent,
  pageEvents,
  SECRET_DOMAIN,
  SECRET_PATH_PREFIX,
  spyOnConsole,
  T0,
  tick,
  uuid,
  World,
  waitFor,
  withOverrides,
} from "./support/world";

let world: World;
let inst: Instance;
let consoleSpy: ReturnType<typeof spyOnConsole>;

beforeEach(() => {
  world = new World();
  world.install();
  inst = world.open();
  consoleSpy = spyOnConsole();
});
afterEach(() => {
  try {
    world.alarms.expectOnlyRetryAlarm();
    expectBatchesValid(world.server);
    consoleSpy.expectSilent();
  } finally {
    consoleSpy.restore();
    world.uninstall();
  }
});

const enqueue = (events: CapturedEvent[]) => world.enqueue(inst, events);
const depth = async () => (await inst.store.stats()).depth;
const queuedIds = async () => (await world.queued(inst)).map((e) => e.id);
const ids = (events: CapturedEvent[]) => events.map((e) => e.id);
const status = () => inst.flusher.getSyncStatus();

describe("request shape", () => {
  it("POSTs the batch to the paired server's /v1/ingest/events with only the ingest key", async () => {
    const events = pageEvents(3);
    await enqueue(events);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });

    expect(world.server.calls).toHaveLength(1);
    const call = world.server.calls[0];
    expect(call?.url).toBe(`${ORIGIN}/v1/ingest/events`);
    expect(call?.init.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("content-type")).toMatch(/^application\/json/);
    // Nothing else identifies the caller: no cookies, no tenant or integration headers.
    for (const name of call?.headers.keys() ?? []) {
      expect(["authorization", "content-type", "accept"]).toContain(name);
    }
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.signal?.aborted).toBe(false);
  });

  it("sends a body that satisfies the contracts, with the stored events untouched and in order", async () => {
    const events = pageEvents(5);
    await enqueue(events);
    await inst.flusher.flush();
    const body = JSON.parse(world.server.calls[0]?.body ?? "null");
    expect(ingestBatchRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toStrictEqual({ events });
    for (const event of body.events) expect(parseEvent(event).ok).toBe(true);
    // Nothing of the queue's bookkeeping leaks into the request.
    expect(world.server.calls[0]?.body).not.toMatch(/queuedAt|"seq"/);
    expect(await world.server.stored.size).toBe(5);
  });

  it("sends nothing and keeps the queue when there is no stored connection", async () => {
    await enqueue(pageEvents(2));
    world.connection = null;
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "not_connected" });
    expect(world.server.calls).toHaveLength(0);
    expect(await depth()).toBe(2);
    expect((await status()).state).toBe("not_connected");
    // Pairing later resumes delivery of what was queued meanwhile.
    world.connection = connectionFor(KEY);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls).toHaveLength(1);
    expect(await depth()).toBe(0);
  });

  it("makes no request for an empty queue", async () => {
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls).toHaveLength(0);
  });

  it("reads the connection on every flush, so a re-pair is picked up at once", async () => {
    world.server.expectedKey = KEY_2;
    world.connection = connectionFor(KEY_2);
    await enqueue(pageEvents(1));
    await inst.flusher.flush();
    expect(world.server.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY_2}`);
  });

  it("splits a long queue into batches of at most 100, oldest first, until it is empty", async () => {
    const events = pageEvents(250);
    await enqueue(events);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls.map((call) => call.events.length)).toEqual([100, 100, 50]);
    expect(world.server.sentIds()).toEqual(ids(events));
    expect(await depth()).toBe(0);
  });

  it("keeps every body within 256 KB of UTF-8 even when 100 events would not fit", async () => {
    const events = Array.from({ length: 100 }, (_, i) => bigEvent(i));
    await enqueue(events);
    await inst.flusher.flush();
    expect(world.server.calls.length).toBeGreaterThan(1);
    for (const call of world.server.calls) {
      expect(call.bytes).toBeLessThanOrEqual(INGEST_MAX_BATCH_BYTES);
      expect(call.status).toBe(200); // the server never had to say 413
    }
    expect(world.server.sentIds()).toEqual(ids(events));
    expect(await depth()).toBe(0);
  });

  it("never sends an event that fails local validation (for example a query string) and notes it without payload", async () => {
    const withQuery = {
      ...pageEvent(1),
      data: { ...pageEvent(1).data, path: "/a?token=SECRET" },
    } as unknown as CapturedEvent;
    const unknownType = { ...pageEvent(3), type: "nonsense.type" } as unknown as CapturedEvent;
    await enqueue([pageEvent(0), withQuery, pageEvent(2), unknownType]);
    await inst.flusher.flush();
    expect(world.server.sentIds()).toEqual([pageEvent(0).id, pageEvent(2).id]);
    expect(world.server.calls.map((call) => call.body).join("")).not.toContain("SECRET");
    expect(await depth()).toBe(0);
    const stats = await inst.store.stats();
    expect(stats.rejectedCount).toBe(2);
    const notes = (await inst.store.getMeta()).rejectedNotes;
    expect(notes).toEqual([
      { id: withQuery.id, code: "client.event_invalid", at: T0 },
      { id: unknownType.id, code: "client.event_invalid", at: T0 },
    ]);
    expect(JSON.stringify(notes)).not.toContain("SECRET");
  });

  it("drops events older than the age limit before sending, and counts them", async () => {
    inst = world.open({ maxAgeMs: 60_000 });
    await enqueue(pageEvents(3));
    world.clock = T0 + 60_001;
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(0);
    expect((await inst.store.stats()).droppedCount).toBe(3);
    expect(await depth()).toBe(0);
  });
});

describe("per-item results", () => {
  it("deletes accepted events and the ones the server already had (duplicate)", async () => {
    const events = pageEvents(4);
    world.server.stored.set(events[1]?.id ?? "", events[1]);
    world.server.stored.set(events[3]?.id ?? "", events[3]);
    await enqueue(events);
    await inst.flusher.flush();
    expect(await depth()).toBe(0);
    expect(world.server.accepted.size).toBe(2);
    expect((await inst.store.stats()).rejectedCount).toBe(0);
    expect((await status()).consecutiveFailures).toBe(0);
  });

  it("deletes an event the server dropped by rule, counts it, and never retries it", async () => {
    const dropped = pageEvent(1, { path: "/ruledrop/1" });
    await enqueue([pageEvent(0), dropped]);
    await inst.flusher.flush();
    expect(await depth()).toBe(0);
    expect((await inst.store.stats()).ruleDroppedCount).toBe(1);
    expect(world.server.stored.has(dropped.id)).toBe(false);
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);
  });

  it.each(INGEST_ERROR_CODES)(
    "removes only the rejected event for %s and keeps a payload-free local note",
    async (code) => {
      world.server.rejectRule = (event) =>
        (event as { data?: { path?: string } }).data?.path === "/poison/x" ? code : null;
      const bad = pageEvent(1, { path: "/poison/x" });
      await enqueue([pageEvent(0), bad, pageEvent(2)]);
      await inst.flusher.flush();
      expect(await depth()).toBe(0);
      expect([...world.server.accepted.keys()]).toEqual([pageEvent(0).id, pageEvent(2).id]);
      expect((await inst.store.stats()).rejectedCount).toBe(1);
      expect((await inst.store.getMeta()).rejectedNotes).toEqual([{ id: bad.id, code, at: T0 }]);
      expect(world.server.calls).toHaveLength(1); // not retried
    },
  );

  it("handles a batch with every outcome at once (partial batch failure) and leaves nothing behind", async () => {
    const events = [
      pageEvent(0), // accepted
      pageEvent(1), // duplicate
      pageEvent(2, { path: "/ruledrop/2" }), // dropped
      pageEvent(3, { path: "/poison/3" }), // rejected
      pageEvent(4), // accepted
      pageEvent(5, { path: "/poison/5" }), // rejected
    ];
    world.server.stored.set(events[1]?.id ?? "", events[1]);
    await enqueue(events);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls).toHaveLength(1);
    expect(await depth()).toBe(0);
    expect(ids(events.filter((_, i) => [0, 4].includes(i)))).toEqual([
      ...world.server.accepted.keys(),
    ]);
    expect(await inst.store.stats()).toMatchObject({ ruleDroppedCount: 1, rejectedCount: 2 });
    expect((await inst.store.getMeta()).rejectedNotes.map((note) => note.id)).toEqual([
      events[3]?.id,
      events[5]?.id,
    ]);
  });

  it("applies one batch's result in ONE readwrite transaction", async () => {
    await enqueue([
      pageEvent(0),
      pageEvent(1, { path: "/ruledrop/1" }),
      pageEvent(2, { path: "/poison/2" }),
    ]);
    const before = world.server.delivered;
    await inst.flusher.flush();
    // Transactions opened after the response arrived: exactly one.
    expect(world.readwriteSince(before + 1)).toHaveLength(1);
  });

  it("a partial failure across batches keeps the unsent part: 100 delivered, then a network error", async () => {
    const events = pageEvents(150);
    await enqueue(events);
    world.server.next({ kind: "ok" }, { kind: "network" });
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(await queuedIds()).toEqual(ids(events.slice(100)));
    expect(world.server.accepted.size).toBe(100);

    world.clock += BACKOFF_CAP_MS * 2;
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.accepted.size).toBe(150);
    expect([...world.server.accepted.values()].every((n) => n === 1)).toBe(true);
    expect(world.server.calls[2]?.ids).toEqual(ids(events.slice(100)));
  });

  it("keeps events enqueued while a request is in flight (delete by id only) and sends them afterwards", async () => {
    await enqueue(pageEvents(3));
    const release = world.server.holdNextResponse();
    const first = inst.flusher.flush();
    await waitFor(() => world.server.calls.length === 1);
    await enqueue(pageEvents(2, 3));
    release();
    await first;
    expect(world.server.accepted.size).toBe(5);
    expect([...world.server.accepted.values()].every((n) => n === 1)).toBe(true);
    expect(await depth()).toBe(0);
  });
});

describe("malformed or misaligned responses are failures: nothing is deleted", () => {
  const cases: [string, (results: { id?: string; status: string }[]) => unknown][] = [
    ["fewer results than events", (r) => ({ results: r.slice(0, -1) })],
    [
      "more results than events",
      (r) => ({ results: [...r, { id: uuid(900), status: "accepted" }] }),
    ],
    ["results in the wrong order", (r) => ({ results: [...r].reverse() })],
    [
      "a result for the wrong id",
      (r) => ({ results: r.map((x, i) => (i === 1 ? { ...x, id: uuid(901) } : x)) }),
    ],
    ["an unknown status", (r) => ({ results: r.map((x) => ({ ...x, status: "weird" })) })],
    ["no results key", () => ({})],
    ["an extra key", (r) => ({ results: r, extra: true })],
    ["a body that is not JSON", () => "<html>proxy error</html>"],
  ];

  it.each(cases)("treats %s as a failure", async (_name, body) => {
    const events = pageEvents(3);
    await enqueue(events);
    world.server.next({ kind: "mangle", body: body as never });
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(await queuedIds()).toEqual(ids(events));
    expect(await status()).toMatchObject({ consecutiveFailures: 1, lastFailure: "bad_response" });
    expect(world.alarms.lastWhen).toBe(T0 + BACKOFF_BASE_MS);

    // The same ids go out again; the server dedupes them; the queue empties.
    world.clock += BACKOFF_BASE_MS;
    await inst.flusher.flush();
    expect(world.server.calls[1]?.ids).toEqual(ids(events));
    expect(await depth()).toBe(0);
    expect([...world.server.accepted.values()]).toEqual([1, 1, 1]);
  });
});

describe("failures keep everything and back off with jitter, scheduled through an alarm", () => {
  it("treats a network failure as retryable: queue intact, one-shot retry alarm after the base delay", async () => {
    const events = pageEvents(3);
    await enqueue(events);
    world.server.next({ kind: "network" });
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(await queuedIds()).toEqual(ids(events));
    expect(world.alarms.creates).toEqual([
      { name: FLUSH_RETRY_ALARM_NAME, when: T0 + BACKOFF_BASE_MS },
    ]);
    expect(await status()).toEqual({
      state: "connected",
      consecutiveFailures: 1,
      nextAttemptAt: T0 + BACKOFF_BASE_MS,
      lastSuccessAt: null,
      lastFailure: "network",
    });
  });

  it.each([500, 502, 503, 504])("treats HTTP %i as retryable", async (code) => {
    await enqueue(pageEvents(2));
    world.server.next({ kind: "status", status: code });
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(await depth()).toBe(2);
    expect(await status()).toMatchObject({ consecutiveFailures: 1, lastFailure: "server" });
  });

  it("treats a request that timed out (aborted) as a network failure", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "network", message: "The operation was aborted" });
    await inst.flusher.flush();
    expect(await status()).toMatchObject({ consecutiveFailures: 1, lastFailure: "network" });
    expect(await depth()).toBe(1);
  });

  it("treats a failure after the server stored the batch the same way, and later gets duplicate for those ids", async () => {
    const events = pageEvents(3);
    await enqueue(events);
    world.server.next({ kind: "processThenNetwork" });
    await inst.flusher.flush();
    expect(await depth()).toBe(3);
    expect(world.server.stored.size).toBe(3);
    world.clock += BACKOFF_BASE_MS;
    await inst.flusher.flush();
    expect(await depth()).toBe(0);
    expect(world.server.stored.size).toBe(3);
    expect([...world.server.accepted.values()]).toEqual([1, 1, 1]);
  });

  it("makes no request before the backoff elapsed, whatever triggers the flush, and one exactly when it elapsed", async () => {
    await enqueue(pageEvents(2));
    world.server.next({ kind: "network" });
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);

    world.clock = T0 + BACKOFF_BASE_MS - 1;
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    await inst.flusher.onAlarm({ name: HEARTBEAT_ALARM_NAME });
    await inst.flusher.onAlarm({ name: FLUSH_RETRY_ALARM_NAME });
    await enqueue(pageEvents(1, 2)); // a new event does not skip the backoff either
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);

    world.clock = T0 + BACKOFF_BASE_MS;
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(2);
    expect(await depth()).toBe(0);
  });

  it("doubles the delay per consecutive failure up to the cap (30 s, 60 s, ... 15 min)", async () => {
    await enqueue(pageEvents(1));
    const expected = [30, 60, 120, 240, 480, 900, 900, 900].map((s) => s * 1000);
    for (const delay of expected) {
      world.server.next({ kind: "status", status: 500 });
      await inst.flusher.flush();
      expect(world.alarms.lastWhen).toBe(world.clock + delay);
      world.clock = world.clock + delay; // the retry alarm fires
    }
    expect((await status()).consecutiveFailures).toBe(expected.length);
  });

  it("adds jitter from the injected random source: never below the raw delay, at most 25 % above", async () => {
    await enqueue(pageEvents(1));
    for (const [random, expectedWhen] of [
      [0, T0 + 30_000],
      [0.5, T0 + 33_750],
      [0.999999, T0 + 37_499],
    ] as const) {
      world.random = random;
      const fresh = world.open();
      world.clock = T0;
      await fresh.store.settle({
        removeSeqs: [],
        sync: { consecutiveFailures: 0, nextAttemptAt: null },
      });
      world.server.next({ kind: "network" });
      await fresh.flusher.flush();
      expect(world.alarms.lastWhen).toBe(expectedWhen);
    }
  });

  it("resets the backoff after a success", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "network" }, { kind: "network" });
    await inst.flusher.flush();
    world.clock = world.alarms.lastWhen ?? 0;
    await inst.flusher.flush();
    expect((await status()).consecutiveFailures).toBe(2);

    world.clock = world.alarms.lastWhen ?? 0;
    await inst.flusher.flush(); // succeeds
    expect(await status()).toEqual({
      state: "connected",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastSuccessAt: world.clock,
      lastFailure: null,
    });

    await enqueue(pageEvents(1, 1));
    world.server.next({ kind: "network" });
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(world.clock + BACKOFF_BASE_MS); // back to the base delay
  });

  it("persists the backoff: after a kill the new background still waits, then continues doubling", async () => {
    await enqueue(pageEvents(2));
    world.server.next({ kind: "network" });
    await inst.flusher.flush();
    const nextAttemptAt = (await status()).nextAttemptAt;
    expect(nextAttemptAt).toBe(T0 + BACKOFF_BASE_MS);

    world.alarms.pending.clear(); // the browser forgot its alarms
    const createdBefore = world.alarms.creates.length;
    inst = await world.restart(inst);
    // start() re-armed the one-shot alarm at the persisted time.
    expect(world.alarms.creates.slice(createdBefore)).toEqual([
      { name: FLUSH_RETRY_ALARM_NAME, when: nextAttemptAt },
    ]);

    world.clock = T0 + 1_000;
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(world.server.calls).toHaveLength(1);

    world.clock = nextAttemptAt ?? 0;
    world.server.next({ kind: "network" });
    await inst.flusher.flush();
    expect((await status()).consecutiveFailures).toBe(2);
    expect(world.alarms.lastWhen).toBe(world.clock + 2 * BACKOFF_BASE_MS);
  });

  it("does not arm any alarm on start when nothing is pending", async () => {
    await inst.flusher.start();
    expect(world.alarms.creates).toEqual([]);
  });

  it("never touches the 30 s heartbeat alarm, however many failures pile up", async () => {
    await enqueue(pageEvents(1));
    for (let i = 0; i < 4; i++) {
      world.server.next({ kind: "status", status: 503 });
      await inst.flusher.flush();
      world.clock = world.alarms.lastWhen ?? 0;
    }
    expect(world.alarms.creates.length).toBeGreaterThan(0);
    world.alarms.expectOnlyRetryAlarm();
  });
});

describe("429 and Retry-After", () => {
  it("honours Retry-After seconds when they exceed the backoff", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 429, headers: { "retry-after": "120" } });
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(world.alarms.lastWhen).toBe(T0 + 120_000);
    expect(await status()).toMatchObject({
      consecutiveFailures: 1,
      lastFailure: "rate_limited",
      nextAttemptAt: T0 + 120_000,
    });
    expect(await depth()).toBe(1);
    world.clock = T0 + 119_999;
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);
  });

  it("never retries sooner than the backoff, even if Retry-After is shorter", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 429, headers: { "retry-after": "1" } });
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(T0 + BACKOFF_BASE_MS);
  });

  it("caps an absurd Retry-After", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 429, headers: { "retry-after": "99999999" } });
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(T0 + RETRY_AFTER_MAX_MS);
  });

  it("ignores a Retry-After it cannot read and falls back to the backoff", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 429, headers: { "retry-after": "soon" } });
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(T0 + BACKOFF_BASE_MS);
  });

  it("honours Retry-After on a 503 as well", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 503, headers: { "retry-after": "300" } });
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(T0 + 300_000);
    expect((await status()).lastFailure).toBe("server");
  });

  it("counts the next 429 on top: the backoff keeps growing", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 429 }, { kind: "status", status: 429 });
    await inst.flusher.flush();
    world.clock = world.alarms.lastWhen ?? 0;
    await inst.flusher.flush();
    expect(world.alarms.lastWhen).toBe(world.clock + 2 * BACKOFF_BASE_MS);
  });
});

describe("other 4xx on the whole request keep the queue (nothing is deleted without a per-item result)", () => {
  it.each([403, 404, 405, 408, 409, 410, 422])(
    "treats HTTP %i as a retryable client error, not a disconnect",
    async (code) => {
      await enqueue(pageEvents(2));
      world.server.next({ kind: "status", status: code });
      await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
      expect(await depth()).toBe(2);
      expect(await status()).toMatchObject({
        state: "connected",
        consecutiveFailures: 1,
        lastFailure: "client_error",
      });
    },
  );
});

describe("whole-request 400/413: halve the batch, never delete without a per-item result", () => {
  it("halves on 400 ingest.batch_invalid and resends the OLDEST half, without counting a failure", async () => {
    const events = pageEvents(8);
    await enqueue(events);
    world.server.maxEventsPerRequest = 4; // answers 400 above that
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls.map((call) => [call.events.length, call.status])).toEqual([
      [8, 400],
      [4, 200],
      [4, 200],
    ]);
    expect(world.server.calls[1]?.ids).toEqual(ids(events.slice(0, 4)));
    expect(world.server.calls[2]?.ids).toEqual(ids(events.slice(4)));
    expect(await depth()).toBe(0);
    expect(await status()).toMatchObject({ consecutiveFailures: 0, nextAttemptAt: null });
    expect(world.alarms.creates).toEqual([]);
  });

  it("halves on 413 http.payload_too_large", async () => {
    const events = Array.from({ length: 8 }, (_, i) => bigEvent(i));
    await enqueue(events);
    world.server.maxBytesPerRequest = 20_000; // 8 big events are ~33 KB, 4 are ~17 KB
    await inst.flusher.flush();
    expect(world.server.calls.map((call) => call.status)).toEqual([413, 200, 200]);
    expect(world.server.calls.map((call) => call.events.length)).toEqual([8, 4, 4]);
    expect(await depth()).toBe(0);
  });

  it("halves on a 400/413 whatever the body (a proxy page, not problem+json)", async () => {
    await enqueue(pageEvents(4));
    world.server.next({ kind: "status", status: 413, body: "<html>too large</html>" });
    await inst.flusher.flush();
    expect(world.server.calls.map((call) => call.events.length)).toEqual([4, 2, 2]);
    expect(await depth()).toBe(0);
  });

  it("at a batch of one it is a plain failure: the event is kept, with backoff, and the run stops", async () => {
    const events = pageEvents(3);
    await enqueue(events);
    world.server.fallback = {
      kind: "status",
      status: 413,
      body: { code: "http.payload_too_large" },
    };
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "backoff" });
    expect(world.server.calls.map((call) => call.events.length)).toEqual([3, 1]);
    expect(await queuedIds()).toEqual(ids(events));
    expect(await status()).toMatchObject({ consecutiveFailures: 1, lastFailure: "client_error" });
    expect((await inst.store.stats()).rejectedCount).toBe(0);
    expect(world.alarms.lastWhen).toBe(T0 + BACKOFF_BASE_MS);
  });
});

describe("401 puts the extension in the disconnected state", () => {
  it("stops, keeps every queued event, schedules no retry and never uses the dead key again", async () => {
    const events = pageEvents(4);
    await enqueue(events);
    world.server.revoke(); // revoked on the server: every request now answers 401
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "disconnected" });
    expect(await queuedIds()).toEqual(ids(events));
    expect((await status()).state).toBe("disconnected");
    expect(world.alarms.creates).toEqual([]);

    // Nothing wakes it up: not another flush, not either alarm, not a new event.
    await inst.flusher.flush();
    await inst.flusher.onAlarm({ name: HEARTBEAT_ALARM_NAME });
    await inst.flusher.onAlarm({ name: FLUSH_RETRY_ALARM_NAME });
    await enqueue(pageEvents(1, 4));
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "disconnected" });
    expect(world.server.calls).toHaveLength(1);
    expect(await depth()).toBe(5);
  });

  it("is persisted: a restarted background is still disconnected and sends nothing", async () => {
    await enqueue(pageEvents(2));
    world.server.expectedKey = KEY_2; // the stored key KEY is not accepted
    await inst.flusher.flush();
    expect((await status()).state).toBe("disconnected");
    inst = await world.restart(inst);
    expect((await status()).state).toBe("disconnected");
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "disconnected" });
    expect(world.server.calls).toHaveLength(1);
    expect(world.alarms.creates).toEqual([]);
  });

  it("keeps what an earlier batch already delivered and only the rest stays queued", async () => {
    const events = pageEvents(150);
    await enqueue(events);
    world.server.next(
      { kind: "ok" },
      { kind: "status", status: 401, body: { code: "auth.invalid_key" } },
    );
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "disconnected" });
    expect(await queuedIds()).toEqual(ids(events.slice(100)));
  });

  it("resumes with a DIFFERENT ingest key for the SAME owner (origin and integration) and sends the retained queue with it, never with the old one", async () => {
    const events = pageEvents(3);
    await enqueue(events);
    world.server.expectedKey = KEY_2;
    await inst.flusher.flush(); // KEY is refused
    expect((await status()).state).toBe("disconnected");

    world.connection = connectionFor(KEY_2); // the user paired again
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });
    expect(world.server.calls.map((call) => call.headers.get("authorization"))).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${KEY_2}`,
    ]);
    expect((await status()).state).toBe("connected");
    expect(await depth()).toBe(0);
    expect(world.server.accepted.size).toBe(3);
  });

  it("the same key stored again does not resume (it is still dead)", async () => {
    await enqueue(pageEvents(1));
    world.server.revoke();
    await inst.flusher.flush();
    world.connection = connectionFor(KEY);
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);
  });

  it("reports not_connected once the connection is removed, and never sends then", async () => {
    await enqueue(pageEvents(1));
    world.server.revoke();
    await inst.flusher.flush();
    world.connection = null;
    expect((await status()).state).toBe("not_connected");
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "not_connected" });
    expect(world.server.calls).toHaveLength(1);
  });

  it("clearQueue deletes every queued event, keeps counters and stays disconnected", async () => {
    inst = world.open({ maxEvents: 3 });
    await enqueue(pageEvents(5)); // 2 dropped by the cap
    world.server.revoke();
    await inst.flusher.flush();
    await expect(inst.flusher.clearQueue()).resolves.toBe(3);
    expect(await depth()).toBe(0);
    expect((await inst.store.stats()).droppedCount).toBe(2);
    expect((await status()).state).toBe("disconnected");
    await enqueue(pageEvents(1, 10));
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1);
  });

  it("does not treat 403 or a 5xx as a disconnect", async () => {
    await enqueue(pageEvents(1));
    world.server.next({ kind: "status", status: 403 }, { kind: "status", status: 500 });
    await inst.flusher.flush();
    world.clock = world.alarms.lastWhen ?? 0;
    await inst.flusher.flush();
    expect((await status()).state).toBe("connected");
  });
});

describe("single flight and listeners", () => {
  it("never has two requests in flight; a call during a run is covered by a later run", async () => {
    await enqueue(pageEvents(3));
    const release = world.server.holdNextResponse();
    const first = inst.flusher.flush();
    await waitFor(() => world.server.calls.length === 1);

    await enqueue(pageEvents(2, 3)); // committed before the second flush() call
    const second = inst.flusher.flush();
    const third = inst.flusher.onAlarm({ name: HEARTBEAT_ALARM_NAME });
    for (let i = 0; i < 20; i++) await tick();
    expect(world.server.calls).toHaveLength(1);

    release();
    await Promise.all([first, second, third]);
    expect(world.server.maxConcurrent).toBe(1);
    expect(world.server.accepted.size).toBe(5);
    expect([...world.server.accepted.values()].every((n) => n === 1)).toBe(true);
    expect(await depth()).toBe(0);
  });

  it("returns the flush promise from the flush alarms, resolving to undefined, for Firefox's keep-alive", async () => {
    await enqueue(pageEvents(1));
    const result = inst.flusher.onAlarm({ name: FLUSH_RETRY_ALARM_NAME });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(world.server.calls).toHaveLength(1);

    await enqueue(pageEvents(1, 1));
    const heartbeat = inst.flusher.onAlarm({ name: HEARTBEAT_ALARM_NAME });
    expect(heartbeat).toBeInstanceOf(Promise);
    await expect(heartbeat).resolves.toBeUndefined();
    expect(world.server.calls).toHaveLength(2);
  });

  it("ignores alarms that are not its own", async () => {
    await enqueue(pageEvents(1));
    expect(inst.flusher.onAlarm({ name: "something-else" })).toBeUndefined();
    await tick();
    expect(world.server.calls).toHaveLength(0);
  });

  it("never rejects, even when the store fails", async () => {
    await enqueue(pageEvents(1));
    const broken = withOverrides(inst.store, {
      peekBatch: () => Promise.reject(new Error(`broken ${KEY} ${SECRET_DOMAIN}`)),
    });
    const flusher = createFlusher({
      store: broken,
      getConnection: async () => connectionFor(KEY),
      fetch: world.server.fetch,
      alarms: world.alarms,
      now: world.now,
      random: () => 0,
    });
    const result = await flusher.flush();
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(world.server.calls).toHaveLength(0);
    await expect(flusher.start()).resolves.toBeUndefined();
  });

  it("never rejects when the stored connection cannot be read", async () => {
    await enqueue(pageEvents(1));
    const flusher = createFlusher({
      store: inst.store,
      getConnection: () => Promise.reject(new Error("storage unavailable")),
      fetch: world.server.fetch,
      alarms: world.alarms,
      now: world.now,
      random: () => 0,
    });
    await expect(flusher.flush()).resolves.toMatchObject({ status: "not_connected" });
    expect(world.server.calls).toHaveLength(0);
  });
});

describe("silence: no logs, no timers, no secrets in anything the flush exposes", () => {
  it("logs nothing and leaks no key, URL, domain or path through results, status or notes", async () => {
    const outputs: unknown[] = [];
    await enqueue([...pageEvents(2), pageEvent(2, { path: "/poison/2" })]);
    const behaviors = [
      {
        kind: "network",
        message: `connect failed to ${ORIGIN} with ${KEY} for ${SECRET_DOMAIN}${SECRET_PATH_PREFIX}`,
      },
      { kind: "status", status: 500, body: `oops ${KEY} ${SECRET_DOMAIN}` },
      { kind: "mangle", body: () => `garbage ${KEY}` },
      { kind: "status", status: 429, headers: { "retry-after": "10" } },
    ] as const;
    for (const behavior of behaviors) {
      world.server.next(behavior);
      outputs.push(await inst.flusher.flush(), await status());
      world.clock = (world.alarms.lastWhen ?? world.clock) + 1;
    }
    await inst.flusher.flush(); // succeeds; one event is rejected with a note
    world.server.revoke();
    await enqueue(pageEvents(1, 7));
    outputs.push(
      await inst.flusher.flush(),
      await status(),
      await inst.store.getMeta(),
      await inst.store.stats(),
    );

    const text = JSON.stringify(outputs);
    for (const secret of [KEY, ORIGIN, SECRET_DOMAIN, SECRET_PATH_PREFIX, "pa_ing_"]) {
      expect(text).not.toContain(secret);
    }
    consoleSpy.expectSilent();
  });

  it("schedules no timer of its own (alarms only)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      await enqueue(pageEvents(3));
      world.server.next({ kind: "network" });
      await inst.flusher.flush();
      world.clock += BACKOFF_BASE_MS;
      await inst.flusher.flush();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});

// M2-R fix: the queue records its owner (server origin + integration). Events queued for one owner
// are never sent under another owner's key, whatever the sync state says.
describe("queue owner scoping (events never reach a different server or integration)", () => {
  const owners = [
    {
      label: "a different integration on the same server",
      owner: { integrationId: INTEGRATION_ID_2 },
    },
    { label: "a different server", owner: { serverOrigin: ORIGIN_2 } },
    {
      label: "a different server AND integration",
      owner: { serverOrigin: ORIGIN_2, integrationId: INTEGRATION_ID_2 },
    },
  ];

  it("the store reports no owner until one is set, then returns it, also after a restart", async () => {
    await expect(inst.store.getOwner()).resolves.toBeNull();
    await inst.store.setOwner(ownerOf(connectionFor(KEY)));
    await expect(inst.store.getOwner()).resolves.toEqual(ownerOf(connectionFor(KEY)));
    inst = await world.restart(inst);
    await expect(inst.store.getOwner()).resolves.toEqual(ownerOf(connectionFor(KEY)));
  });

  it("setOwner only records the owner: it does not clear or re-stamp queued events", async () => {
    await enqueue(pageEvents(2));
    await inst.store.setOwner(ownerOf(connectionFor(KEY, { serverOrigin: ORIGIN_2 })));
    expect(await depth()).toBe(2);
    const rows = await inst.store.peekBatch();
    for (const row of rows) expect(row.owner).toEqual(ownerOf(connectionFor(KEY)));
  });

  for (const { label, owner } of owners) {
    it(`after a 401, pairing ${label} sends NONE of the old events (not even under the new key)`, async () => {
      const old = pageEvents(3);
      await enqueue(old);
      world.server.expectedKey = KEY_2;
      await inst.flusher.flush(); // KEY is refused: disconnected
      expect((await status()).state).toBe("disconnected");

      world.connection = connectionFor(KEY_2, owner); // paired again, as another owner
      await inst.flusher.flush();
      expect(world.server.calls).toHaveLength(1); // only the refused request; nothing under KEY_2
      for (const id of ids(old)) expect(world.server.sentIds().slice(1)).not.toContain(id);
      expect(world.server.accepted.size).toBe(0);

      // New events captured for the new owner do flow, and only they.
      const fresh = pageEvents(2, 10);
      await enqueue(fresh);
      await inst.flusher.flush();
      expect(world.server.acceptedIds().sort()).toEqual(ids(fresh).sort());
      expect(world.server.calls.slice(1).map((c) => c.headers.get("authorization"))).toEqual([
        `Bearer ${KEY_2}`,
      ]);
    });

    it(`rows queued for the previous owner are never flushed when the connection is ${label}, without any 401`, async () => {
      const old = pageEvents(2);
      await enqueue(old); // stamped for the first connection
      world.connection = connectionFor(KEY, owner);
      const fresh = pageEvents(1, 10);
      await enqueue(fresh); // stamped for the new owner
      await inst.flusher.flush();
      expect(world.server.sentIds()).toEqual(ids(fresh));
      for (const id of ids(old)) expect(world.server.sentIds()).not.toContain(id);
    });

    it(`a flush under ${label} never sends the old events, even when the old queue is all that exists`, async () => {
      await enqueue(pageEvents(3));
      world.connection = connectionFor(KEY, owner);
      await inst.flusher.flush();
      expect(world.server.calls).toEqual([]);
    });
  }

  it("the same owner after a 401 keeps and sends its queue with the new key", async () => {
    const events = pageEvents(2);
    await enqueue(events);
    world.server.expectedKey = KEY_2;
    await inst.flusher.flush();
    world.connection = connectionFor(KEY_2); // same origin and integration
    await inst.flusher.flush();
    expect(world.server.acceptedIds().sort()).toEqual(ids(events).sort());
  });

  it("clearQueue also removes rows of a previous owner (nothing lingers)", async () => {
    await enqueue(pageEvents(2));
    world.connection = connectionFor(KEY, { serverOrigin: ORIGIN_2 });
    await enqueue(pageEvents(1, 5));
    await expect(inst.flusher.clearQueue()).resolves.toBe(3);
    expect(await depth()).toBe(0);
  });
});
