// Raw IndexedDB for the Spike A prototype (no `idb` wrapper: the throwaway needs three operations
// and explicit control over transaction scope, the synchronous read-modify-write inside one
// transaction, and durability; M2-05 adopts `idb` per the plan).
//
// Layout:
//   queue  (keyPath 'seq', autoIncrement)  captured events in capture order, never drained here
//   state  (keyPath 'key')                 one record 'main': open segment, heartbeat, tab marks
//
// Every transition reads 'main', computes synchronously and writes 'main' plus its events in ONE
// readwrite transaction over both stores. IndexedDB transactions are atomic: if the worker is
// stopped before the commit, the transaction aborts and neither the events nor the new state exist.
// Overlapping readwrite transactions run strictly in creation order, so concurrent transitions
// (a capture racing a focus step) cannot lose each other's updates.

import { initialState, type PersistedState, type QueuedEvent, type Transition } from "./core";

const DB_NAME = "pa-spike-mv3-lifecycle";
const DB_VERSION = 1;
const QUEUE = "queue";
const STATE = "state";
const MAIN = "main";

interface StateRecord extends PersistedState {
  key: typeof MAIN;
}

let dbPromise: Promise<IDBDatabase> | undefined;

/** Opened once per worker start and reused, so a capture starts its transaction immediately. */
export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(QUEUE, { keyPath: "seq", autoIncrement: true });
      db.createObjectStore(STATE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise.catch(() => {
    dbPromise = undefined;
  });
  return dbPromise;
}

const toState = (record: StateRecord | undefined): PersistedState => {
  if (!record) return initialState();
  const { key: _key, ...state } = record;
  return { ...initialState(), ...state, diag: { ...initialState().diag, ...state.diag } };
};

/**
 * Runs `compute` on the persisted state inside one readwrite transaction and stores its result
 * and events atomically (durability 'strict'). Resolves only after the commit. If `compute`
 * throws, the transaction is aborted and nothing changes (fail closed).
 */
export async function transact(
  compute: (prev: PersistedState) => Transition,
  options: { clearQueue?: boolean } = {},
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([QUEUE, STATE], "readwrite", { durability: "strict" });
  let computeError: unknown;
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(computeError ?? tx.error ?? new Error("transaction aborted"));
  });
  const queue = tx.objectStore(QUEUE);
  const store = tx.objectStore(STATE);
  if (options.clearQueue) queue.clear();
  const read = store.get(MAIN);
  read.onsuccess = () => {
    let next: Transition;
    try {
      next = compute(toState(read.result as StateRecord | undefined));
    } catch (error) {
      computeError = error;
      tx.abort();
      return;
    }
    for (const event of next.events) queue.add(event);
    store.put({ key: MAIN, ...next.state } satisfies StateRecord);
  };
  await completion;
}

export async function readState(): Promise<PersistedState> {
  const db = await openDb();
  const read = db.transaction(STATE, "readonly").objectStore(STATE).get(MAIN);
  return new Promise((resolve, reject) => {
    read.onsuccess = () => resolve(toState(read.result as StateRecord | undefined));
    read.onerror = () => reject(read.error);
  });
}

/** The whole queue in capture order (by auto-increment key), without the storage key. */
export async function readQueue(): Promise<QueuedEvent[]> {
  const db = await openDb();
  const read = db.transaction(QUEUE, "readonly").objectStore(QUEUE).getAll();
  return new Promise((resolve, reject) => {
    read.onsuccess = () =>
      resolve(
        (read.result as (QueuedEvent & { seq: number })[]).map(
          ({ seq: _seq, ...event }) => event as QueuedEvent,
        ),
      );
    read.onerror = () => reject(read.error);
  });
}
