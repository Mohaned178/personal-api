// M2-R fix: the popup's "Clear local queue" action (offered when Disconnected or after Disconnect).
// The DOM wiring in entrypoints/popup/main.ts is thin; the logic is `canClearQueue` (state) and
// `clearLocalQueue` (action) in lib/popup-state.ts, tested here with the M2-05 World.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLocalQueue, loadPopupState } from "../lib/popup-state";
import { type Instance, pageEvents, World } from "./queue/support/world";

let world: World;
let inst: Instance;
beforeEach(() => {
  world = new World();
  world.install();
  inst = world.open();
});
afterEach(() => world.uninstall());

const deps = () => ({
  getConnection: async () => (world.connection ? { ...world.connection } : null),
  flusher: inst.flusher,
  store: inst.store,
  storage: { get: async () => ({}) },
});

async function disconnectWithQueue(n: number): Promise<void> {
  await world.enqueue(inst, pageEvents(n));
  world.server.revoke();
  await inst.flusher.flush(); // 401: Disconnected
}

describe("canClearQueue", () => {
  it("is offered when Disconnected (401) and events are queued", async () => {
    await disconnectWithQueue(3);
    const state = await loadPopupState(deps());
    expect(state).toMatchObject({ status: "disconnected", queueDepth: 3, canClearQueue: true });
  });

  it("is offered after Disconnect (no connection) while events are still queued", async () => {
    await world.enqueue(inst, pageEvents(2));
    world.connection = null;
    const state = await loadPopupState(deps());
    expect(state).toMatchObject({ status: "not_connected", queueDepth: 2, canClearQueue: true });
  });

  it("is not offered while connected, even with a queue", async () => {
    await world.enqueue(inst, pageEvents(2));
    const state = await loadPopupState(deps());
    expect(state).toMatchObject({ connection: "connected", canClearQueue: false });
  });

  it("is not offered when the queue is empty", async () => {
    world.connection = null;
    expect((await loadPopupState(deps())).canClearQueue).toBe(false);
  });
});

describe("clearLocalQueue", () => {
  it("clears every queued event, and the returned snapshot shows depth 0 and no clear button", async () => {
    await disconnectWithQueue(4);
    const state = await clearLocalQueue(deps());
    expect((await inst.store.stats()).depth).toBe(0);
    expect(state).toMatchObject({ queueDepth: 0, canClearQueue: false, status: "disconnected" });
  });

  it("goes through flusher.clearQueue exactly once", async () => {
    await disconnectWithQueue(2);
    let calls = 0;
    const flusher = {
      ...inst.flusher,
      clearQueue: () => {
        calls++;
        return inst.flusher.clearQueue();
      },
    };
    await clearLocalQueue({ ...deps(), flusher });
    expect(calls).toBe(1);
  });

  it("never rejects when clearing fails, and still reports the real depth", async () => {
    await disconnectWithQueue(2);
    const flusher = { ...inst.flusher, clearQueue: () => Promise.reject(new Error("boom")) };
    const state = await clearLocalQueue({ ...deps(), flusher });
    expect(state.queueDepth).toBe(2);
    expect((await inst.store.stats()).depth).toBe(2);
  });

  it("does not touch the network or the stored connection", async () => {
    await disconnectWithQueue(2);
    const before = world.server.calls.length;
    await clearLocalQueue(deps());
    expect(world.server.calls.length).toBe(before);
    expect(world.connection).not.toBeNull();
  });
});
