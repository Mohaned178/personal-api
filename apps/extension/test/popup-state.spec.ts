// M2-06 popup status selector (lib/popup-state.ts): connection state, pause, queue depth, last
// sync, dropped count. Fixed clock through the queue World; no timers.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAUSED_STORAGE_KEY } from "../lib/pause";
import { loadPopupState } from "../lib/popup-state";
import {
  connectionFor,
  INTEGRATION_ID,
  KEY,
  KEY_2,
  pageEvents,
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

function deps(inst: ReturnType<World["open"]>, stored: Record<string, unknown> = {}) {
  return {
    getConnection: async () => (world.connection ? { ...world.connection } : null),
    flusher: inst.flusher,
    store: inst.store,
    storage: { get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}) },
  };
}

describe("loadPopupState", () => {
  it("a fresh install is not_connected, with zeroed counters", async () => {
    world.connection = null;
    const state = await loadPopupState(deps(world.open()));
    expect(state).toMatchObject({
      connection: "not_connected",
      status: "not_connected",
      serverOrigin: null,
      integrationName: null,
      paused: false,
      queueDepth: 0,
      lastSyncAt: null,
      droppedCount: 0,
    });
  });

  it("connected and not paused is collecting, and names the server and integration", async () => {
    const state = await loadPopupState(deps(world.open()));
    expect(state).toMatchObject({
      connection: "connected",
      status: "collecting",
      serverOrigin: connectionFor().serverOrigin,
      integrationName: "Test browser",
      paused: false,
    });
  });

  it("paused wins over collecting", async () => {
    const state = await loadPopupState(deps(world.open(), { [PAUSED_STORAGE_KEY]: true }));
    expect(state).toMatchObject({ connection: "connected", paused: true, status: "paused" });
  });

  it("unreadable pause storage reports paused (fail closed)", async () => {
    const inst = world.open();
    const state = await loadPopupState({
      ...deps(inst),
      storage: {
        get: async () => {
          throw new Error("nope");
        },
      },
    });
    expect(state.paused).toBe(true);
    expect(state.status).not.toBe("collecting");
  });

  it("reports the queue depth", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(7));
    expect((await loadPopupState(deps(inst))).queueDepth).toBe(7);
  });

  it("reports the last successful sync time, and null before any", async () => {
    const inst = world.open();
    expect((await loadPopupState(deps(inst))).lastSyncAt).toBeNull();
    await world.enqueue(inst, pageEvents(2));
    world.clock = T0 + 5_000;
    await inst.flusher.flush();
    const state = await loadPopupState(deps(inst));
    expect(state.lastSyncAt).toBe(T0 + 5_000);
    expect(state.queueDepth).toBe(0);
  });

  it("a failed sync does not move the last sync time", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(1));
    await inst.flusher.flush();
    const synced = (await loadPopupState(deps(inst))).lastSyncAt;
    await world.enqueue(inst, pageEvents(1, 10));
    world.clock = T0 + 60_000;
    world.server.fallback = { kind: "network" };
    await inst.flusher.flush();
    expect((await loadPopupState(deps(inst))).lastSyncAt).toBe(synced);
  });

  it("reports the local drop count after a queue overflow", async () => {
    const inst = world.open({ maxEvents: 3 });
    await world.enqueue(inst, pageEvents(8));
    const state = await loadPopupState(deps(inst));
    expect(state.queueDepth).toBe(3);
    expect(state.droppedCount).toBe(5);
  });

  it("keeps rule drops and rejections out of the dropped count", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(2));
    const rows = await inst.store.peekBatch();
    await inst.store.settle({
      removeSeqs: rows.map((row) => row.seq),
      ruleDropped: 1,
      rejected: [{ id: rows[1]?.event.id ?? "", code: "ingest.payload_invalid", at: T0 }],
    });
    const state = await loadPopupState(deps(inst));
    expect(state).toMatchObject({ droppedCount: 0, ruleDroppedCount: 1, rejectedCount: 1 });
  });

  it("a 401 shows disconnected (even when paused), until a different key is stored", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(1));
    world.server.revoke();
    await inst.flusher.flush();
    const paused = { [PAUSED_STORAGE_KEY]: true };
    expect(await loadPopupState(deps(inst, paused))).toMatchObject({
      connection: "disconnected",
      status: "disconnected",
    });
    world.connection = connectionFor(KEY_2);
    world.server.expectedKey = KEY_2;
    await inst.flusher.flush();
    expect((await loadPopupState(deps(inst))).status).toBe("collecting");
  });

  it("never exposes the ingest key", async () => {
    const inst = world.open();
    await world.enqueue(inst, pageEvents(1));
    const json = JSON.stringify(await loadPopupState(deps(inst)));
    expect(json).not.toContain(KEY);
    expect(json).not.toContain("pa_ing_");
    expect(json).not.toContain(INTEGRATION_ID);
  });

  it("never rejects: a failing store answers a status that is not collecting", async () => {
    const inst = world.open();
    const broken = withOverrides(inst.store, {
      stats: async () => {
        throw new Error("idb down");
      },
    });
    const state = await loadPopupState({ ...deps(inst), store: broken });
    expect(state.status).not.toBe("collecting");
  });
});
