// M2-05 (1) createIdbCaptureStore as the capture engine's CaptureStore, (2) the queue repository,
// (4) the 50,000 events / 14 days cap with a persisted, reported drop counter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedEvent, CaptureState } from "../../lib/capture";
import {
  MAX_QUEUE_AGE_MS,
  MAX_QUEUE_EVENTS,
  type QueueStore,
  REJECT_NOTES_MAX,
} from "../../lib/queue";
import { bigEvent, bodyBytes, DAY, pageEvent, pageEvents, T0, World } from "./support/world";

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => {
  world.uninstall();
});

const store = (limits?: { maxEvents?: number; maxAgeMs?: number }): QueueStore =>
  world.open(limits).store;

const append = (s: QueueStore, events: CapturedEvent[], state: CaptureState = { ok: true }) =>
  s.transact(() => ({ state, events }));

const queuedIds = async (s: QueueStore): Promise<string[]> =>
  (await s.peekBatch({ maxEvents: 1_000_000, maxBytes: Number.MAX_SAFE_INTEGER })).map(
    (row) => row.event.id,
  );

describe("CaptureStore.transact over IndexedDB", () => {
  it("calls compute exactly once, with null before the first commit and the last state after", async () => {
    const s = store();
    const first = vi.fn((_prev: CaptureState | null) => ({ state: { n: 1 }, events: [] }));
    await s.transact(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(null);

    const second = vi.fn((prev: CaptureState | null) => ({
      state: { n: Number(prev?.n) + 1 },
      events: [],
    }));
    await s.transact(second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ n: 1 });
  });

  it("commits the new state and the queued events together", async () => {
    const s = store();
    const events = pageEvents(3);
    await s.transact(() => ({ state: { open: "segment" }, events }));
    expect(await queuedIds(s)).toEqual(events.map((e) => e.id));
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ open: "segment" });
  });

  it("stores events exactly as given: same id, same data, no extra keys, never regenerated", async () => {
    const s = store();
    const events = pageEvents(2);
    await append(s, events);
    const rows = await s.peekBatch();
    expect(rows.map((row) => row.event)).toStrictEqual(events);
    for (const row of rows) {
      expect(Object.keys(row.event).sort()).toEqual(Object.keys(events[0] as object).sort());
    }
  });

  it("stamps queuedAt from the injected clock", async () => {
    const s = store();
    world.clock = T0 + 5_000;
    await append(s, pageEvents(1));
    world.clock = T0 + 9_000;
    await append(s, pageEvents(1, 1));
    const rows = await s.peekBatch();
    expect(rows.map((row) => row.queuedAt)).toEqual([T0 + 5_000, T0 + 9_000]);
  });

  it("rejects when compute throws and stores nothing", async () => {
    const s = store();
    await append(s, pageEvents(1), { n: 1 });
    await expect(
      s.transact(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await queuedIds(s)).toHaveLength(1);
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ n: 1 });
  });

  it("rejects when compute returns a promise (no await inside a transaction) and stores nothing", async () => {
    const s = store();
    const asyncCompute = (async () => ({ state: { n: 1 }, events: pageEvents(1) })) as unknown as (
      prev: CaptureState | null,
    ) => { state: CaptureState; events: CapturedEvent[] };
    await expect(s.transact(asyncCompute)).rejects.toBeDefined();
    expect(await queuedIds(s)).toEqual([]);
    let seen: CaptureState | null | undefined;
    await s.transact((prev) => {
      seen = prev;
      return { state: {}, events: [] };
    });
    expect(seen).toBeNull();
  });

  it("hands compute a copy of the state: mutating it and then failing leaves the stored state alone", async () => {
    const s = store();
    await append(s, [], { nested: { n: 1 } });
    await expect(
      s.transact((prev) => {
        (prev as { nested: { n: number } }).nested.n = 99;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ nested: { n: 1 } });
  });

  it("is all-or-nothing: events that cannot be stored also leave the new state unwritten", async () => {
    const s = store();
    await append(s, pageEvents(1), { n: 1 });
    const unclonable = { ...pageEvent(50), data: { fn: () => 1 } } as unknown as CapturedEvent;
    await expect(
      s.transact(() => ({ state: { n: 2 }, events: [pageEvent(51), unclonable] })),
    ).rejects.toBeDefined();
    expect(await queuedIds(s)).toEqual([pageEvent(0).id]);
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ n: 1 });
  });

  it("is all-or-nothing: a state that cannot be stored also leaves the new events unwritten", async () => {
    const s = store();
    await expect(
      s.transact(() => ({ state: { fn: () => 1 }, events: pageEvents(2) })),
    ).rejects.toBeDefined();
    expect(await queuedIds(s)).toEqual([]);
  });

  it("is all-or-nothing when the worker dies inside the transaction", async () => {
    const s = store();
    await append(s, pageEvents(1), { n: 1 });
    world.abortNextReadwrite();
    await expect(
      s.transact(() => ({ state: { n: 2 }, events: pageEvents(2, 10) })),
    ).rejects.toBeDefined();
    expect(world.abortedTransactions).toBe(1);
    expect(await queuedIds(s)).toEqual([pageEvent(0).id]);
    // The store is still usable afterwards.
    await append(s, pageEvents(1, 20), { n: 3 });
    expect(await queuedIds(s)).toEqual([pageEvent(0).id, pageEvent(20).id]);
  });

  it("applies overlapping transactions one after another in call order", async () => {
    const s = store();
    const seenPrev: unknown[] = [];
    const calls = [0, 1, 2, 3, 4].map((i) =>
      s.transact((prev) => {
        seenPrev.push(prev === null ? null : prev.n);
        return { state: { n: Number(prev?.n ?? 0) + 1 }, events: [pageEvent(i)] };
      }),
    );
    await Promise.all(calls);
    expect(seenPrev).toEqual([null, 1, 2, 3, 4]);
    expect(await queuedIds(s)).toEqual([0, 1, 2, 3, 4].map((i) => pageEvent(i).id));
  });

  it("keeps call order when a middle transaction fails", async () => {
    const s = store();
    const first = s.transact(() => ({ state: { n: 1 }, events: [pageEvent(0)] }));
    const failing = s.transact(() => {
      throw new Error("middle");
    });
    const third = s.transact((prev) => ({
      state: { n: Number(prev?.n) + 1 },
      events: [pageEvent(2)],
    }));
    await expect(failing).rejects.toThrow("middle");
    await Promise.all([first, third]);
    expect(await queuedIds(s)).toEqual([pageEvent(0).id, pageEvent(2).id]);
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ n: 2 });
  });

  it("survives a worker kill: a new store over the same database sees state and events", async () => {
    const before = world.open();
    await append(before.store, pageEvents(3), { open: "segment", n: 7 });
    // No close(): a killed worker never closes anything.
    const after = world.open();
    let seen: CaptureState | null = null;
    await after.store.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [pageEvent(3)] };
    });
    expect(seen).toEqual({ open: "segment", n: 7 });
    expect(await queuedIds(after.store)).toEqual(pageEvents(4).map((e) => e.id));
  });

  it("keeps a new seq increasing after rows were removed and after a restart", async () => {
    const first = world.open();
    await append(first.store, pageEvents(3));
    const rows = await first.store.peekBatch();
    await first.store.settle({ removeSeqs: rows.map((row) => row.seq) });
    const second = world.open();
    await append(second.store, pageEvents(1, 3));
    const after = await second.store.peekBatch();
    expect(after).toHaveLength(1);
    expect(after[0]?.seq).toBeGreaterThan(Math.max(...rows.map((row) => row.seq)));
  });

  it('opens every readwrite transaction with durability "strict"', async () => {
    const s = store({ maxEvents: 3 });
    await append(s, pageEvents(5));
    const rows = await s.peekBatch();
    await s.settle({
      removeSeqs: [rows[0]?.seq ?? -1],
      rejected: [],
      sync: { consecutiveFailures: 1 },
    });
    await s.applyLimits();
    await s.clear();
    const readwrite = world.transactions.filter((tx) => tx.mode === "readwrite");
    expect(readwrite.length).toBeGreaterThanOrEqual(3);
    for (const tx of readwrite) expect(tx.durability).toBe("strict");
  });

  it("rejects every operation after close() and writes nothing", async () => {
    const s = store();
    await append(s, pageEvents(1));
    s.close();
    s.close();
    await expect(append(s, pageEvents(1, 1))).rejects.toBeDefined();
    const reopened = world.open();
    expect(await queuedIds(reopened.store)).toEqual([pageEvent(0).id]);
  });
});

describe("queue repository", () => {
  it("returns an empty batch for an empty queue", async () => {
    expect(await store().peekBatch()).toEqual([]);
  });

  it("peeks oldest first in insertion order, not by id or occurredAt", async () => {
    const s = store();
    const events = pageEvents(12); // ids and occurredAt are deliberately not monotonic
    await append(s, events.slice(0, 5));
    await append(s, events.slice(5));
    const ids = events.map((e) => e.id);
    expect([...ids].sort()).not.toEqual(ids);
    expect((await s.peekBatch()).map((row) => row.event.id)).toEqual(ids);
  });

  it("peeks at most 100 events by default and leaves the rest queued", async () => {
    const s = store();
    await append(s, pageEvents(250));
    const batch = await s.peekBatch();
    expect(batch).toHaveLength(100);
    expect(batch.map((row) => row.event.id)).toEqual(pageEvents(100).map((e) => e.id));
    expect((await s.stats()).depth).toBe(250);
  });

  it("honours maxEvents", async () => {
    const s = store();
    await append(s, pageEvents(10));
    expect(await s.peekBatch({ maxEvents: 3 })).toHaveLength(3);
  });

  it("limits the batch by UTF-8 body bytes of the whole {events} body, not by UTF-16 length", async () => {
    const s = store();
    const events = [bigEvent(0), bigEvent(1), bigEvent(2)];
    await append(s, events);
    const two = bodyBytes(events.slice(0, 2));
    const threeUtf16 = JSON.stringify({ events }).length;
    // The trap: counted in UTF-16 units all three would fit under `two` bytes.
    expect(threeUtf16).toBeLessThan(two);
    expect(await s.peekBatch({ maxBytes: two })).toHaveLength(2);
    expect(await s.peekBatch({ maxBytes: two - 1 })).toHaveLength(1);
    expect(await s.peekBatch({ maxBytes: bodyBytes(events) })).toHaveLength(3);
  });

  it("applies the default byte budget of 256 KB", async () => {
    const s = store();
    await append(
      s,
      Array.from({ length: 100 }, (_, i) => bigEvent(i)),
    );
    const batch = await s.peekBatch();
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(100);
    expect(bodyBytes(batch.map((row) => row.event))).toBeLessThanOrEqual(256 * 1024);
    expect(bodyBytes(batch.map((row) => row.event).concat(bigEvent(0)))).toBeGreaterThan(
      256 * 1024,
    );
  });

  it("returns the oldest event alone when it is bigger than the byte budget (never an empty batch)", async () => {
    const s = store();
    await append(s, [bigEvent(0), bigEvent(1)]);
    const batch = await s.peekBatch({ maxBytes: 10 });
    expect(batch.map((row) => row.event.id)).toEqual([bigEvent(0).id]);
  });

  it("peeking is read-only", async () => {
    const s = store();
    await append(s, pageEvents(3));
    const before = world.transactions.length;
    await s.peekBatch();
    await s.stats();
    expect(world.transactions.slice(before).every((tx) => tx.mode === "readonly")).toBe(true);
    expect(await queuedIds(s)).toHaveLength(3);
  });

  it("settle deletes by seq only: events enqueued after the peek survive", async () => {
    const s = store();
    await append(s, pageEvents(3));
    const peeked = await s.peekBatch();
    await append(s, pageEvents(2, 3)); // enqueued while the request was in flight
    await s.settle({ removeSeqs: peeked.map((row) => row.seq) });
    expect(await queuedIds(s)).toEqual(pageEvents(2, 3).map((e) => e.id));
  });

  it("settle ignores a seq that no longer exists", async () => {
    const s = store();
    await append(s, pageEvents(2));
    const peeked = await s.peekBatch();
    await s.settle({ removeSeqs: [peeked[0]?.seq ?? 0] });
    await expect(s.settle({ removeSeqs: [peeked[0]?.seq ?? 0, 99_999] })).resolves.toBeUndefined();
    expect(await queuedIds(s)).toEqual([pageEvent(1).id]);
  });

  it("settle applies removal, counters, notes and sync state in ONE transaction", async () => {
    const s = store();
    await append(s, pageEvents(3));
    const peeked = await s.peekBatch();
    const before = world.transactions.length;
    await s.settle({
      removeSeqs: peeked.map((row) => row.seq),
      ruleDropped: 2,
      rejected: [{ id: pageEvent(0).id, code: "ingest.payload_invalid", at: T0 }],
      sync: { consecutiveFailures: 0, lastSuccessAt: T0 },
    });
    const readwrite = world.transactions.slice(before).filter((tx) => tx.mode === "readwrite");
    expect(readwrite).toHaveLength(1);
    const stats = await s.stats();
    expect(stats).toMatchObject({ depth: 0, ruleDroppedCount: 2, rejectedCount: 1 });
    expect((await s.getMeta()).rejectedNotes).toEqual([
      { id: pageEvent(0).id, code: "ingest.payload_invalid", at: T0 },
    ]);
  });

  it("settle is all-or-nothing when the worker dies inside it", async () => {
    const s = store();
    await append(s, pageEvents(3));
    const peeked = await s.peekBatch();
    world.abortNextReadwrite();
    await expect(
      s.settle({
        removeSeqs: peeked.map((row) => row.seq),
        ruleDropped: 3,
        rejected: [{ id: pageEvent(0).id, code: "ingest.payload_invalid", at: T0 }],
        sync: { consecutiveFailures: 4 },
      }),
    ).rejects.toBeDefined();
    expect(await queuedIds(s)).toHaveLength(3);
    expect(await s.stats()).toMatchObject({ ruleDroppedCount: 0, rejectedCount: 0 });
    expect((await s.getMeta()).sync.consecutiveFailures).toBe(0);
  });

  it("reports depth, the oldest queuedAt and zeroed counters for the heartbeat", async () => {
    const s = store();
    expect(await s.stats()).toEqual({
      depth: 0,
      oldestQueuedAt: null,
      droppedCount: 0,
      ruleDroppedCount: 0,
      rejectedCount: 0,
    });
    world.clock = T0 + 1_000;
    await append(s, pageEvents(2));
    world.clock = T0 + 4_000;
    await append(s, pageEvents(1, 2));
    expect(await s.stats()).toMatchObject({ depth: 3, oldestQueuedAt: T0 + 1_000 });
  });

  it("starts with the default sync state, merges updates shallowly and keeps them across a restart", async () => {
    const first = world.open();
    expect((await first.store.getMeta()).sync).toEqual({
      state: "connected",
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastSuccessAt: null,
      lastFailure: null,
      disconnectedFor: null,
    });
    await first.store.settle({
      removeSeqs: [],
      sync: { consecutiveFailures: 2, nextAttemptAt: T0 + 60_000, lastFailure: "server" },
    });
    await first.store.settle({ removeSeqs: [], sync: { lastSuccessAt: T0 } });
    const second = world.open();
    expect((await second.store.getMeta()).sync).toEqual({
      state: "connected",
      consecutiveFailures: 2,
      nextAttemptAt: T0 + 60_000,
      lastSuccessAt: T0,
      lastFailure: "server",
      disconnectedFor: null,
    });
  });

  it("keeps counters across a restart and only the newest rejection notes", async () => {
    const first = world.open();
    const notes = Array.from({ length: REJECT_NOTES_MAX + 20 }, (_, i) => ({
      id: pageEvent(i).id,
      code: "ingest.payload_invalid",
      at: T0 + i,
    }));
    await first.store.settle({ removeSeqs: [], rejected: notes.slice(0, 60), ruleDropped: 1 });
    await first.store.settle({ removeSeqs: [], rejected: notes.slice(60), ruleDropped: 1 });
    const second = world.open();
    expect(await second.store.stats()).toMatchObject({
      rejectedCount: REJECT_NOTES_MAX + 20,
      ruleDroppedCount: 2,
    });
    const kept = (await second.store.getMeta()).rejectedNotes;
    expect(kept).toHaveLength(REJECT_NOTES_MAX);
    expect(kept).toEqual(notes.slice(20));
  });

  it("clear() deletes every event, keeps the capture state and does not count them as dropped", async () => {
    const s = store();
    await append(s, pageEvents(5), { open: "segment" });
    await expect(s.clear()).resolves.toBe(5);
    expect(await queuedIds(s)).toEqual([]);
    expect(await s.getDroppedCount()).toBe(0);
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ open: "segment" });
    await expect(s.clear()).resolves.toBe(0);
  });
});

describe("queue caps: 50,000 events / 14 days, oldest dropped first, counted", () => {
  it("pins the plan's numbers", () => {
    expect(MAX_QUEUE_EVENTS).toBe(50_000);
    expect(MAX_QUEUE_AGE_MS).toBe(14 * DAY);
  });

  it("keeps exactly the cap and drops nothing at the boundary", async () => {
    const s = store({ maxEvents: 5 });
    await append(s, pageEvents(5));
    expect(await queuedIds(s)).toHaveLength(5);
    expect(await s.getDroppedCount()).toBe(0);
  });

  it("drops the OLDEST events on overflow and counts them", async () => {
    const s = store({ maxEvents: 5 });
    await append(s, pageEvents(3));
    await append(s, pageEvents(4, 3)); // 7 > 5: the two oldest (0 and 1) go
    expect(await queuedIds(s)).toEqual(pageEvents(5, 2).map((e) => e.id));
    expect(await s.getDroppedCount()).toBe(2);
    expect((await s.stats()).droppedCount).toBe(2);
  });

  it("drops the oldest of one oversized transaction, in the same commit as the new state", async () => {
    const s = store({ maxEvents: 5 });
    await s.transact(() => ({ state: { n: 1 }, events: pageEvents(8) }));
    expect(await queuedIds(s)).toEqual(pageEvents(5, 3).map((e) => e.id));
    expect(await s.getDroppedCount()).toBe(3);
    let seen: CaptureState | null = null;
    await s.transact((prev) => {
      seen = prev;
      return { state: prev ?? {}, events: [] };
    });
    expect(seen).toEqual({ n: 1 });
  });

  it("does not lose the drop counter on a failed overflow commit", async () => {
    const s = store({ maxEvents: 2 });
    await append(s, pageEvents(2));
    world.abortNextReadwrite();
    await expect(append(s, pageEvents(2, 2))).rejects.toBeDefined();
    expect(await s.getDroppedCount()).toBe(0);
    expect(await queuedIds(s)).toEqual(pageEvents(2).map((e) => e.id));
  });

  it("persists the drop counter across restarts and clear() never resets it", async () => {
    const first = world.open({ maxEvents: 2 });
    await append(first.store, pageEvents(5));
    expect(await first.store.getDroppedCount()).toBe(3);
    const second = world.open({ maxEvents: 2 });
    expect(await second.store.getDroppedCount()).toBe(3);
    await second.store.clear();
    expect(await second.store.getDroppedCount()).toBe(3);
    await append(second.store, pageEvents(3, 10));
    expect(await second.store.getDroppedCount()).toBe(4);
  });

  it("enforces the real 50,000 cap when no limit is injected", async () => {
    const s = store();
    await s.transact(() => ({ state: {}, events: pageEvents(MAX_QUEUE_EVENTS + 3) }));
    const stats = await s.stats();
    expect(stats.depth).toBe(MAX_QUEUE_EVENTS);
    expect(stats.droppedCount).toBe(3);
    const oldest = await s.peekBatch({ maxEvents: 1 });
    expect(oldest[0]?.event.id).toBe(pageEvent(3).id);
  }, 120_000);

  it("drops an event once it is strictly older than the age limit, never at exactly the limit", async () => {
    const s = store({ maxAgeMs: 1_000 });
    await append(s, pageEvents(1));
    world.clock = T0 + 1_000; // age == limit: kept
    await expect(s.applyLimits()).resolves.toBe(0);
    expect(await queuedIds(s)).toHaveLength(1);
    world.clock = T0 + 1_001; // age > limit: dropped
    await expect(s.applyLimits()).resolves.toBe(1);
    expect(await queuedIds(s)).toEqual([]);
    expect(await s.getDroppedCount()).toBe(1);
  });

  it("drops only the expired events, oldest first, and counts them", async () => {
    const s = store({ maxAgeMs: 10_000 });
    await append(s, pageEvents(2)); // queued at T0
    world.clock = T0 + 6_000;
    await append(s, pageEvents(2, 2)); // queued at T0 + 6 s
    world.clock = T0 + 12_000; // the first two are 12 s old, the others 6 s
    await s.applyLimits();
    expect(await queuedIds(s)).toEqual(pageEvents(2, 2).map((e) => e.id));
    expect(await s.getDroppedCount()).toBe(2);
  });

  it("applies the age limit on every transact too, even one that adds nothing", async () => {
    const s = store({ maxAgeMs: 10_000 });
    await append(s, pageEvents(3));
    world.clock = T0 + 10_001;
    await s.transact((prev) => ({ state: prev ?? {}, events: [] }));
    expect(await queuedIds(s)).toEqual([]);
    expect(await s.getDroppedCount()).toBe(3);
  });

  it("measures age from the moment it was queued, not from the event's occurredAt", async () => {
    const s = store({ maxAgeMs: 10_000 });
    const ancient = {
      ...pageEvent(0),
      occurredAt: new Date(T0 - 60 * DAY).toISOString(),
    } as CapturedEvent;
    await append(s, [ancient]);
    world.clock = T0 + 5_000;
    await s.applyLimits();
    expect(await queuedIds(s)).toEqual([ancient.id]);
  });

  it("uses 14 days by default", async () => {
    const s = store();
    await append(s, pageEvents(1));
    world.clock = T0 + 14 * DAY;
    expect(await s.applyLimits()).toBe(0);
    world.clock = T0 + 14 * DAY + 1;
    expect(await s.applyLimits()).toBe(1);
  });

  it("a result for rows the cap already dropped is harmless and does not double count", async () => {
    const s = store({ maxEvents: 2 });
    await append(s, pageEvents(2));
    const inFlight = await s.peekBatch();
    await append(s, pageEvents(2, 2)); // the in-flight rows are capped away meanwhile
    expect(await s.getDroppedCount()).toBe(2);
    await expect(s.settle({ removeSeqs: inFlight.map((row) => row.seq) })).resolves.toBeUndefined();
    expect(await s.getDroppedCount()).toBe(2);
    expect(await queuedIds(s)).toEqual(pageEvents(2, 2).map((e) => e.id));
  });
});
