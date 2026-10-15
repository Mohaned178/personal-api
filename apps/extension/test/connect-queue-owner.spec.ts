// M2-R fix: connect() ties the local queue to the paired owner (server origin + integration).
// Pairing a different owner discards the old queue; the same owner keeps it. Uses the real
// IndexedDB queue store from the M2-05 World, with browser and network deps injected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectDeps, connect, disconnect } from "../lib/connect";
import {
  connectionFor,
  INTEGRATION_ID,
  INTEGRATION_ID_2,
  type Instance,
  ORIGIN,
  ORIGIN_2,
  ownerOf,
  pageEvents,
  World,
} from "./queue/support/world";

const NEW_KEY = "pa_ing_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function pairBody(integrationId: string) {
  return {
    integration: {
      id: integrationId,
      kind: "browser-extension",
      name: "Laptop",
      defaultPolicy: "deny",
      status: "active",
      lastSeenAt: null,
      createdAt: "2026-10-15T10:00:00.000Z",
    },
    ingestKey: { id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c", key: NEW_KEY, prefix: "pa_ing_CCCC" },
  };
}

let world: World;
let inst: Instance;
beforeEach(() => {
  world = new World();
  world.install();
  inst = world.open();
});
afterEach(() => {
  world.uninstall();
  vi.restoreAllMocks();
});

function depsFor(integrationId: string, options: { fail?: boolean } = {}): ConnectDeps {
  const stored: Record<string, unknown> = {};
  return {
    permissions: { request: async () => true, remove: async () => true },
    storage: {
      get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (items) => void Object.assign(stored, items),
      remove: async (key) => void delete stored[key],
    },
    fetch: async () =>
      new Response(
        JSON.stringify(options.fail ? { code: "pairing.code_invalid" } : pairBody(integrationId)),
        {
          status: options.fail ? 400 : 200,
          headers: { "content-type": "application/json" },
        },
      ),
    queue: inst.store,
  };
}

const input = (url: string) => ({ serverUrl: url, pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" });
const depth = async () => (await inst.store.stats()).depth;

describe("connect() and the queue owner", () => {
  it("pairing a different integration on the same server discards the old queue and records the new owner", async () => {
    await world.enqueue(inst, pageEvents(3));
    expect(await depth()).toBe(3);
    await connect(input(ORIGIN), depsFor(INTEGRATION_ID_2));
    expect(await depth()).toBe(0);
    await expect(inst.store.getOwner()).resolves.toEqual({
      serverOrigin: ORIGIN,
      integrationId: INTEGRATION_ID_2,
    });
  });

  it("pairing a different server discards the old queue and records the new owner", async () => {
    await world.enqueue(inst, pageEvents(3));
    await connect(input(ORIGIN_2), depsFor(INTEGRATION_ID));
    expect(await depth()).toBe(0);
    await expect(inst.store.getOwner()).resolves.toEqual({
      serverOrigin: ORIGIN_2,
      integrationId: INTEGRATION_ID,
    });
  });

  it("pairing the same server and integration again keeps the queue", async () => {
    const events = pageEvents(3);
    await world.enqueue(inst, events);
    await connect(input(ORIGIN), depsFor(INTEGRATION_ID));
    expect((await world.queued(inst)).map((e) => e.id)).toEqual(events.map((e) => e.id));
    await expect(inst.store.getOwner()).resolves.toEqual(ownerOf(connectionFor()));
  });

  it("Disconnect keeps the owner and the queue; pairing another owner afterwards still discards it", async () => {
    await world.enqueue(inst, pageEvents(2));
    const deps = depsFor(INTEGRATION_ID);
    await connect(input(ORIGIN), deps);
    await disconnect(deps);
    expect(await depth()).toBe(2);
    await connect(input(ORIGIN_2), depsFor(INTEGRATION_ID));
    expect(await depth()).toBe(0);
  });

  it("a queue with no recorded owner (written before this fix) is discarded when pairing", async () => {
    // Rows committed while no owner was ever set cannot be proven to belong to the new pairing.
    await inst.store.transact((prev) => ({
      state: prev ?? { created: true },
      events: pageEvents(2),
    }));
    expect(await depth()).toBe(2);
    await connect(input(ORIGIN), depsFor(INTEGRATION_ID));
    expect(await depth()).toBe(0);
  });

  it("a failed pairing (bad code) changes nothing: the queue and its owner stay", async () => {
    await world.enqueue(inst, pageEvents(2));
    await expect(
      connect(input(ORIGIN_2), depsFor(INTEGRATION_ID_2, { fail: true })),
    ).rejects.toThrow();
    expect(await depth()).toBe(2);
    await expect(inst.store.getOwner()).resolves.toEqual(ownerOf(connectionFor()));
  });

  it("an empty queue just gets the new owner recorded", async () => {
    await connect(input(ORIGIN_2), depsFor(INTEGRATION_ID_2));
    await expect(inst.store.getOwner()).resolves.toEqual({
      serverOrigin: ORIGIN_2,
      integrationId: INTEGRATION_ID_2,
    });
  });

  it("end to end: 401, then pairing another account sends nothing old; the new account's events flow", async () => {
    await world.enqueue(inst, pageEvents(3));
    world.server.expectedKey = NEW_KEY; // the old key is refused
    await inst.flusher.flush();
    expect((await inst.flusher.getSyncStatus()).state).toBe("disconnected");

    world.connection = await connect(input(ORIGIN_2), depsFor(INTEGRATION_ID_2));
    await inst.flusher.flush();
    expect(world.server.calls).toHaveLength(1); // the refused request only
    expect(world.server.accepted.size).toBe(0);

    const fresh = pageEvents(1, 20);
    await world.enqueue(inst, fresh);
    await inst.flusher.flush();
    expect(world.server.acceptedIds()).toEqual(fresh.map((e) => e.id));
  });
});
