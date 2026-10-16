// The capture gate's mirror of the queue owner and the 401 marker (lib/gate-mirror.ts): the
// parsers (fail closed), the serialized writer, and what connect() writes on a re-pair.
// The gate itself is tested in test/queue/wire.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTION_STORAGE_KEY, type ConnectDeps, connect } from "../lib/connect";
import {
  createGateMirror,
  GATE_DISCONNECT_STORAGE_KEY,
  GATE_OWNER_STORAGE_KEY,
  parseGateDisconnect,
  parseGateOwner,
} from "../lib/gate-mirror";
import {
  connectionFor,
  INTEGRATION_ID_2,
  type Instance,
  KEY,
  ORIGIN,
  ORIGIN_2,
  ownerOf,
  pageEvents,
  World,
} from "./queue/support/world";

describe("parseGateOwner", () => {
  it("accepts a well-formed owner and nothing else", () => {
    const owner = { serverOrigin: ORIGIN, integrationId: INTEGRATION_ID_2 };
    expect(parseGateOwner(owner)).toEqual(owner);
    expect(parseGateOwner({ ...owner, extra: 1 })).toEqual(owner);
    for (const bad of [
      undefined,
      null,
      "x",
      1,
      [],
      {},
      { serverOrigin: ORIGIN },
      { serverOrigin: 1, integrationId: "a" },
    ]) {
      expect(parseGateOwner(bad)).toBeNull();
    }
  });
});

describe("parseGateDisconnect", () => {
  it("accepts null or a non-empty string marker and nothing else", () => {
    expect(parseGateDisconnect({ disconnectedFor: null })).toEqual({ disconnectedFor: null });
    expect(parseGateDisconnect({ disconnectedFor: "sha256:ab" })).toEqual({
      disconnectedFor: "sha256:ab",
    });
    for (const bad of [
      undefined,
      null,
      "x",
      1,
      [],
      {},
      { disconnectedFor: "" },
      { disconnectedFor: 3 },
      { disconnectedFor: undefined },
    ]) {
      expect(parseGateDisconnect(bad)).toBeNull();
    }
  });
});

describe("createGateMirror", () => {
  let world: World;
  let inst: Instance;
  beforeEach(() => {
    world = new World();
    world.install();
    inst = world.open();
  });
  afterEach(() => world.uninstall());

  it("refresh writes the IndexedDB owner and 401 marker, and never rejects", async () => {
    const written: Record<string, unknown>[] = [];
    const mirror = createGateMirror({
      storage: { set: async (items) => void written.push(items) },
      store: inst.store,
    });
    await mirror.refresh();
    expect(written.at(-1)).toEqual({
      [GATE_OWNER_STORAGE_KEY]: null,
      [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: null },
    });

    await inst.store.setOwner(ownerOf(connectionFor(KEY)));
    await inst.store.settle({
      removeSeqs: [],
      sync: { state: "disconnected", disconnectedFor: "sha256:abc" },
    });
    await mirror.refresh();
    expect(written.at(-1)).toEqual({
      [GATE_OWNER_STORAGE_KEY]: ownerOf(connectionFor(KEY)),
      [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: "sha256:abc" },
    });

    const failing = createGateMirror({
      storage: { set: () => Promise.reject(new Error("quota")) },
      store: inst.store,
    });
    await expect(failing.refresh()).resolves.toBeUndefined();
  });

  it("markDisconnected writes only the marker and reports a failed write", async () => {
    const written: Record<string, unknown>[] = [];
    const mirror = createGateMirror({
      storage: { set: async (items) => void written.push(items) },
      store: inst.store,
    });
    await mirror.markDisconnected("sha256:abc");
    expect(written).toEqual([{ [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: "sha256:abc" } }]);

    const failing = createGateMirror({
      storage: { set: () => Promise.reject(new Error("quota")) },
      store: inst.store,
    });
    await expect(failing.markDisconnected("sha256:abc")).rejects.toThrow("quota");
    // A failed write does not block the next one.
    await expect(failing.refresh()).resolves.toBeUndefined();
  });

  it("runs writes one after another, in call order", async () => {
    const log: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mirror = createGateMirror({
      storage: {
        set: async (items) => {
          log.push(`start:${Object.keys(items).length}`);
          if (log.length === 1) await gate;
          log.push("end");
        },
      },
      store: inst.store,
    });
    const first = mirror.markDisconnected("sha256:one");
    const second = mirror.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(["start:1"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["start:1", "end", "start:2", "end"]);
  });
});

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

describe("connect() and the gate's mirror", () => {
  let world: World;
  let inst: Instance;
  beforeEach(() => {
    world = new World();
    world.install();
    inst = world.open();
  });
  afterEach(() => world.uninstall());

  function pairing(stored: Record<string, unknown>, log: string[] = []) {
    const deps: ConnectDeps = {
      permissions: { request: async () => true, remove: async () => true },
      storage: {
        get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (items) => {
          log.push(`set:${Object.keys(items).join(",")}`);
          Object.assign(stored, items);
        },
        remove: async (key) => void delete stored[key],
      },
      fetch: async () =>
        new Response(JSON.stringify(pairBody(INTEGRATION_ID_2)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      queue: {
        stats: () => inst.store.stats(),
        getOwner: () => inst.store.getOwner(),
        setOwner: (owner) => {
          log.push("queue.setOwner");
          return inst.store.setOwner(owner);
        },
        clear: () => inst.store.clear(),
      },
    };
    return deps;
  }
  const input = { serverUrl: ORIGIN_2, pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" };

  it("a re-pair mirrors the new owner and clears the 401 marker", async () => {
    const stored: Record<string, unknown> = {
      [CONNECTION_STORAGE_KEY]: connectionFor(KEY),
      [GATE_OWNER_STORAGE_KEY]: ownerOf(connectionFor(KEY)),
      [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: "sha256:old" },
    };
    const connection = await connect(input, pairing(stored));
    expect(stored[GATE_OWNER_STORAGE_KEY]).toEqual(ownerOf(connection));
    expect(stored[GATE_DISCONNECT_STORAGE_KEY]).toEqual({ disconnectedFor: null });
    expect(stored[CONNECTION_STORAGE_KEY]).toEqual(connection);
    expect(await inst.store.getOwner()).toEqual(ownerOf(connection));
  });

  it("invalidates the owner mirror first, then writes the new mirror before the connection", async () => {
    const log: string[] = [];
    await world.enqueue(inst, pageEvents(1));
    await connect(input, pairing({}, log));
    expect(log).toEqual([
      `set:${GATE_OWNER_STORAGE_KEY}`,
      "queue.setOwner",
      `set:${GATE_OWNER_STORAGE_KEY},${GATE_DISCONNECT_STORAGE_KEY}`,
      `set:${CONNECTION_STORAGE_KEY}`,
    ]);
  });

  it("a pairing that fails after the queue changed hands leaves the owner mirror missing (deny)", async () => {
    const stored: Record<string, unknown> = {
      [CONNECTION_STORAGE_KEY]: connectionFor(KEY),
      [GATE_OWNER_STORAGE_KEY]: ownerOf(connectionFor(KEY)),
      [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: null },
    };
    const deps = pairing(stored);
    const queue = deps.queue as NonNullable<ConnectDeps["queue"]>;
    deps.queue = { ...queue, setOwner: () => Promise.reject(new Error("indexeddb unavailable")) };
    await expect(connect(input, deps)).rejects.toThrow("indexeddb unavailable");
    // The old connection is still stored, but the mirror no longer names its owner: the gate denies.
    expect(stored[CONNECTION_STORAGE_KEY]).toEqual(connectionFor(KEY));
    expect(stored[GATE_OWNER_STORAGE_KEY]).toBeNull();
  });

  it("without a queue nothing is mirrored (only the connection is written)", async () => {
    const log: string[] = [];
    const deps = pairing({}, log);
    delete deps.queue;
    await connect({ serverUrl: ORIGIN, pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" }, deps);
    expect(log).toEqual([`set:${CONNECTION_STORAGE_KEY}`]);
  });
});
