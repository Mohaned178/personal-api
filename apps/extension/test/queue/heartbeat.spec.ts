// M2-05 (7) the heartbeat payload builder. Sending it is M2-06; only the body is tested here.

import { HEARTBEAT_CLIENT_VERSION_MAX, heartbeatRequestSchema } from "@personal-api/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHeartbeat } from "../../lib/queue";
import { DAY, pageEvents, SECRET_DOMAIN, T0, World } from "./support/world";

let world: World;
beforeEach(() => {
  world = new World();
  world.install();
});
afterEach(() => world.uninstall());

const options = () => ({ now: world.now, clientVersion: "0.1.0" });

describe("buildHeartbeat", () => {
  it("reports an empty queue as depth 0, age 0, nothing dropped", async () => {
    const { store } = world.open();
    const body = await buildHeartbeat(store, options());
    expect(body).toEqual({
      queueDepth: 0,
      oldestQueuedAgeMs: 0,
      droppedCount: 0,
      clientVersion: "0.1.0",
    });
    expect(heartbeatRequestSchema.safeParse(body).success).toBe(true);
  });

  it("reports queue depth and the age of the oldest queued event", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(2));
    world.clock = T0 + 40_000;
    await world.enqueue(inst, pageEvents(3, 2));
    world.clock = T0 + 100_000;
    const body = await buildHeartbeat(inst.store, options());
    expect(body).toMatchObject({ queueDepth: 5, oldestQueuedAgeMs: 100_000, droppedCount: 0 });
    expect(heartbeatRequestSchema.safeParse(body).success).toBe(true);
  });

  it("reports the persisted drop counter after an overflow, so a drop is never silent", async () => {
    const inst = world.open({ maxEvents: 3 });
    await world.enqueue(inst, pageEvents(7));
    const body = await buildHeartbeat(inst.store, options());
    expect(body).toMatchObject({ queueDepth: 3, droppedCount: 4 });
  });

  it("applies the 14-day limit first: expired events are neither counted as queued nor hidden", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(4));
    world.clock = T0 + 14 * DAY + 1;
    const body = await buildHeartbeat(inst.store, options());
    expect(body).toMatchObject({ queueDepth: 0, oldestQueuedAgeMs: 0, droppedCount: 4 });
  });

  it("does not count rule drops or rejections as dropped", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(2));
    const rows = await inst.store.peekBatch();
    await inst.store.settle({
      removeSeqs: rows.map((row) => row.seq),
      ruleDropped: 1,
      rejected: [{ id: rows[1]?.event.id ?? "", code: "ingest.payload_invalid", at: T0 }],
    });
    expect(await buildHeartbeat(inst.store, options())).toMatchObject({ droppedCount: 0 });
  });

  it("never reports a negative age when the clock went backwards", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(1));
    world.clock = T0 - 60_000;
    expect((await buildHeartbeat(inst.store, options())).oldestQueuedAgeMs).toBe(0);
  });

  it("contains exactly the four contract fields and no event data", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(2));
    const body = await buildHeartbeat(inst.store, {
      now: world.now,
      clientVersion: "x".repeat(HEARTBEAT_CLIENT_VERSION_MAX),
    });
    expect(Object.keys(body).sort()).toEqual([
      "clientVersion",
      "droppedCount",
      "oldestQueuedAgeMs",
      "queueDepth",
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET_DOMAIN);
    expect(heartbeatRequestSchema.safeParse(body).success).toBe(true);
  });
});
