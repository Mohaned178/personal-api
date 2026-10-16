// The capture gate's mirror of two facts that live in IndexedDB (ADR 0002 decision 3).
//
// IndexedDB stays the source of truth for the queue owner and the "disconnected after a 401"
// marker. The capture gate must not await IndexedDB (the window between event delivery and commit
// is what option B shrinks), so a copy of both is kept in `browser.storage.local`, where the gate
// reads it in the SAME single `get` as the connection, the pause flag and the allow list. The
// mirror is written next to the IndexedDB write and is only ever READ by the gate; nothing else
// trusts it. Two keys, so two writers never overwrite each other's field (no read-modify-write).
//
// Fail closed (invariant 1): a missing, malformed, stale or mismatched mirror makes the gate deny.
// Nothing in here holds a key, a URL or a domain: an origin, an integration id and an opaque
// SHA-256 based marker.

import type { Connection } from "./connect";
import type { QueueOwner, QueueStore } from "./queue/types";

/** `{ serverOrigin, integrationId }` of the queue owner, or `null` (none). Absent = never written. */
export const GATE_OWNER_STORAGE_KEY = "gateOwner";
/** `{ disconnectedFor: <opaque key marker> | null }`. Absent = never written. */
export const GATE_DISCONNECT_STORAGE_KEY = "gateDisconnect";

/** Both mirror keys, as the capture gate reads them. */
export const GATE_MIRROR_STORAGE_KEYS = [GATE_OWNER_STORAGE_KEY, GATE_DISCONNECT_STORAGE_KEY];

export interface GateMirrorStorage {
  set(items: Record<string, unknown>): Promise<void>;
}

/** The queue owner a connection's events belong to. */
export function connectionOwner(connection: Connection): QueueOwner {
  return { serverOrigin: connection.serverOrigin, integrationId: connection.integrationId };
}

export function sameQueueOwner(a: QueueOwner, b: QueueOwner): boolean {
  return a.serverOrigin === b.serverOrigin && a.integrationId === b.integrationId;
}

/** The mirrored owner, or `null` when it is absent, `null` or malformed (all of which deny). */
export function parseGateOwner(value: unknown): QueueOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { serverOrigin, integrationId } = value as Record<string, unknown>;
  if (typeof serverOrigin !== "string" || typeof integrationId !== "string") return null;
  return { serverOrigin, integrationId };
}

/**
 * The mirrored marker: `{ disconnectedFor }` with `null` meaning "not disconnected". Returns
 * `null` for anything else (absent or malformed), which the gate treats as a deny.
 */
export function parseGateDisconnect(value: unknown): { disconnectedFor: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { disconnectedFor } = value as Record<string, unknown>;
  if (disconnectedFor === null) return { disconnectedFor: null };
  if (typeof disconnectedFor === "string" && disconnectedFor.length > 0) return { disconnectedFor };
  return null;
}

/** What `connect()` writes on a successful pairing: the new owner and no refused key. */
export function pairedMirror(owner: QueueOwner): Record<string, unknown> {
  return {
    [GATE_OWNER_STORAGE_KEY]: {
      serverOrigin: owner.serverOrigin,
      integrationId: owner.integrationId,
    },
    [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: null },
  };
}

export interface GateMirror {
  /**
   * Rewrites both keys from IndexedDB (the source of truth). Never rejects: when a read or the
   * write fails the old mirror stays, which is stale but cannot widen collection on its own (the
   * gate also compares it with the stored connection).
   */
  refresh(): Promise<void>;
  /** Records a 401 for the key with this marker. Called BEFORE the IndexedDB write (fail safe). */
  markDisconnected(marker: string): Promise<void>;
}

/** All writes run one after another, in call order. */
export function createGateMirror(deps: {
  storage: GateMirrorStorage;
  store: Pick<QueueStore, "getOwner" | "getMeta">;
}): GateMirror {
  const { storage, store } = deps;
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const run = chain.then(operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    refresh: () =>
      enqueue(async () => {
        const [owner, { sync }] = await Promise.all([store.getOwner(), store.getMeta()]);
        await storage.set({
          [GATE_OWNER_STORAGE_KEY]:
            owner === null
              ? null
              : { serverOrigin: owner.serverOrigin, integrationId: owner.integrationId },
          [GATE_DISCONNECT_STORAGE_KEY]: {
            disconnectedFor: sync.state === "disconnected" ? sync.disconnectedFor : null,
          },
        });
      }).then(
        () => undefined,
        () => undefined,
      ),
    markDisconnected: (marker) =>
      enqueue(() => storage.set({ [GATE_DISCONNECT_STORAGE_KEY]: { disconnectedFor: marker } })),
  };
}
