// M2-R fix: the background is killed in the middle of a flush (ADR 0002, M2-05 consequences).
// Sent items are deleted only after the server's per-item result, so a new instance resends the
// SAME ids and the server dedupes them: nothing is lost and nothing is stored twice.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapturedEvent } from "../../lib/capture";
import {
  expectBatchesValid,
  type Instance,
  pageEvents,
  spyOnConsole,
  World,
  waitFor,
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

const ids = (events: CapturedEvent[]) => events.map((e) => e.id);
const queuedIds = async () => (await world.queued(inst)).map((e) => e.id);
const depth = async () => (await inst.store.stats()).depth;

/** Starts a flush on the doomed instance. Its request never settles (the background is killed). */
async function startFlushThatGetsKilled(): Promise<void> {
  const before = world.server.calls.length;
  void inst.flusher.flush();
  await waitFor(() => world.server.calls.length === before + 1, "the request to be sent");
}

describe("a background restart in the middle of a flush", () => {
  it("server stored the batch, killed before the response: the new instance resends the same ids, gets duplicate, empties the queue, loses and duplicates nothing", async () => {
    const events = pageEvents(5);
    await world.enqueue(inst, events);
    world.server.next({ kind: "processThenHang" });
    await startFlushThatGetsKilled();

    // The server has the batch; the dead instance never saw the answer, so nothing was deleted.
    expect(world.server.stored.size).toBe(5);
    expect(world.server.calls[0]?.status).toBeNull();
    expect(await queuedIds()).toEqual(ids(events));

    inst = await world.restart(inst);
    expect(await queuedIds()).toEqual(ids(events));
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });

    expect(world.server.calls).toHaveLength(2);
    expect(world.server.calls[1]?.ids).toEqual(world.server.calls[0]?.ids);
    expect(world.server.calls[1]?.ids).toEqual(ids(events));
    expect(world.server.calls[1]?.results?.map((result) => result.status)).toEqual(
      events.map(() => "duplicate"),
    );
    expect(await depth()).toBe(0);
    // Effectively once: stored exactly once, accepted exactly once, rejected and dropped nothing.
    expect(world.server.stored.size).toBe(5);
    expect([...world.server.accepted.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(await inst.store.stats()).toMatchObject({ rejectedCount: 0, ruleDroppedCount: 0 });
  });

  it("server stored the first of several batches, killed before the response: the rest still follows and every event is stored exactly once", async () => {
    const events = pageEvents(150);
    await world.enqueue(inst, events);
    world.server.next({ kind: "processThenHang" });
    await startFlushThatGetsKilled();
    expect(world.server.stored.size).toBe(100);
    expect(await depth()).toBe(150);

    inst = await world.restart(inst);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });

    expect(world.server.calls.slice(1).map((call) => call.ids)).toEqual([
      ids(events.slice(0, 100)),
      ids(events.slice(100)),
    ]);
    expect(world.server.calls[1]?.results?.every((result) => result.status === "duplicate")).toBe(
      true,
    );
    expect(world.server.calls[2]?.results?.every((result) => result.status === "accepted")).toBe(
      true,
    );
    expect(await depth()).toBe(0);
    expect(world.server.stored.size).toBe(150);
    expect([...world.server.accepted.values()].every((n) => n === 1)).toBe(true);
  });

  it("killed with the request in flight and nothing stored: the resend delivers everything once", async () => {
    const events = pageEvents(5);
    await world.enqueue(inst, events);
    world.server.next({ kind: "hang" });
    await startFlushThatGetsKilled();

    expect(world.server.stored.size).toBe(0);
    expect(world.server.calls[0]?.results).toBeNull();
    expect(await queuedIds()).toEqual(ids(events));

    inst = await world.restart(inst);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });

    expect(world.server.calls).toHaveLength(2);
    expect(world.server.calls[1]?.ids).toEqual(ids(events));
    expect(world.server.calls[1]?.results?.map((result) => result.status)).toEqual(
      events.map(() => "accepted"),
    );
    expect(await depth()).toBe(0);
    expect(world.server.stored.size).toBe(5);
    expect([...world.server.accepted.values()]).toEqual([1, 1, 1, 1, 1]);
  });

  it("events captured while the doomed request was in flight survive the kill and are delivered too", async () => {
    const first = pageEvents(3);
    await world.enqueue(inst, first);
    world.server.next({ kind: "processThenHang" });
    await startFlushThatGetsKilled();
    const later = pageEvents(2, 3);
    await world.enqueue(inst, later);

    inst = await world.restart(inst);
    await expect(inst.flusher.flush()).resolves.toEqual({ status: "drained" });

    expect(await depth()).toBe(0);
    expect(world.server.stored.size).toBe(5);
    expect(world.server.acceptedIds().sort()).toEqual(ids([...first, ...later]).sort());
    expect([...world.server.accepted.values()].every((n) => n === 1)).toBe(true);
  });
});
