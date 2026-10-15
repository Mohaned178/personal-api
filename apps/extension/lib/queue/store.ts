import type { CaptureState, CaptureTransition } from "../capture";
import {
  FLUSH_BATCH_MAX_BYTES,
  FLUSH_BATCH_MAX_EVENTS,
  MAX_QUEUE_AGE_MS,
  MAX_QUEUE_EVENTS,
  QUEUE_DB_NAME,
  REJECT_NOTES_MAX,
} from "./constants";
import type {
  BatchLimits,
  CreateStoreOptions,
  QueuedEvent,
  QueueLimits,
  QueueOwner,
  QueueStats,
  QueueStore,
  RejectNote,
  SettleUpdate,
  SyncMeta,
} from "./types";

// One IndexedDB database holds the capture state, the event queue and the sync metadata, so that
// "state change + the events it produces" is one all-or-nothing transaction (ADR 0002 decisions
// 1 and 2). Nothing but IndexedDB requests is awaited inside a transaction.

const DB_VERSION = 1;
const STATE_STORE = "state";
const QUEUE_STORE = "queue";
const META_STORE = "meta";
const AGE_INDEX = "queuedAt";

const CAPTURE_STATE_KEY = "capture";
const SYNC_KEY = "sync";
const COUNTERS_KEY = "counters";
const NOTES_KEY = "notes";
const OWNER_KEY = "owner";

interface Counters {
  dropped: number;
  ruleDropped: number;
  rejected: number;
}

const DEFAULT_SYNC: SyncMeta = {
  state: "connected",
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastSuccessAt: null,
  lastFailure: null,
  disconnectedFor: null,
};

const DEFAULT_COUNTERS: Counters = { dropped: 0, ruleDropped: 0, rejected: 0 };

/** `{"events":[` and `]}` around the comma-joined events. */
const BODY_OVERHEAD_BYTES = 13;

const encoder = new TextEncoder();
const noop = (): void => undefined;

function isOwner(value: unknown): value is QueueOwner {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.serverOrigin === "string" && typeof candidate.integrationId === "string";
}

function sameOwner(row: QueuedEvent, owner: QueueOwner): boolean {
  const rowOwner = row.owner;
  return (
    isOwner(rowOwner) &&
    rowOwner.serverOrigin === owner.serverOrigin &&
    rowOwner.integrationId === owner.integrationId
  );
}

/** Reads the stored owner; anything that is not a well-formed owner counts as none (fail closed). */
async function readOwner(meta: IDBObjectStore): Promise<QueueOwner | null> {
  const stored = await requestResult<unknown>(meta.get(OWNER_KEY));
  return isOwner(stored)
    ? { serverOrigin: stored.serverOrigin, integrationId: stored.integrationId }
    : null;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `work` inside one transaction and resolves only after the transaction committed. If `work`
 * throws, or the transaction aborts (for example the worker is killed), nothing is written and the
 * promise rejects. `work` must await nothing but requests of this transaction.
 */
function runTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx =
        mode === "readwrite"
          ? db.transaction(stores, mode, { durability: "strict" })
          : db.transaction(stores, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result: T | undefined;
    let failure: { error: unknown } | null = null;
    tx.oncomplete = () => {
      if (failure === null) resolve(result as T);
      else reject(failure.error);
    };
    tx.onabort = () => {
      reject(failure !== null ? failure.error : (tx.error ?? new Error("transaction aborted")));
    };
    let pending: Promise<T>;
    try {
      pending = work(tx);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = { error };
        try {
          tx.abort();
        } catch {
          // The transaction already finished; its abort or complete handler settles the promise.
          reject(error);
        }
      },
    );
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STATE_STORE);
      const queue = db.createObjectStore(QUEUE_STORE, { keyPath: "seq", autoIncrement: true });
      queue.createIndex(AGE_INDEX, "queuedAt");
      db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The durable store over IndexedDB. Does not use the `idb` wrapper named in ADR 0002 decision 11:
 * no new dependency was approved for this task, and the few helpers above cover what is needed.
 */
class IdbQueueStore implements QueueStore {
  private readonly factory: IDBFactory;
  private readonly dbName: string;
  private readonly now: () => number;
  private readonly limits: QueueLimits;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private closed = false;
  /** Writers run one after another in call order (never rejects). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: CreateStoreOptions) {
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? QUEUE_DB_NAME;
    this.now = options.now;
    this.limits = {
      maxEvents: options.limits?.maxEvents ?? MAX_QUEUE_EVENTS,
      maxAgeMs: options.limits?.maxAgeMs ?? MAX_QUEUE_AGE_MS,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.dbPromise;
    this.dbPromise = null;
    pending?.then((db) => db.close(), noop);
  }

  private async database(): Promise<IDBDatabase> {
    if (this.closed) throw new Error("the queue store is closed");
    if (this.dbPromise === null) {
      const opening = openDatabase(this.factory, this.dbName).then((db) => {
        db.onversionchange = () => db.close();
        db.onclose = () => {
          if (this.dbPromise === opening) this.dbPromise = null;
        };
        return db;
      });
      opening.catch(() => {
        if (this.dbPromise === opening) this.dbPromise = null;
      });
      this.dbPromise = opening;
    }
    const db = await this.dbPromise;
    if (this.closed) throw new Error("the queue store is closed");
    return db;
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation);
    this.chain = run.then(noop, noop);
    return run;
  }

  private async read<T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return runTransaction(await this.database(), stores, "readonly", work);
  }

  transact(compute: (prev: CaptureState | null) => CaptureTransition): Promise<void> {
    return this.write(async () => {
      const db = await this.database();
      await runTransaction(db, [STATE_STORE, QUEUE_STORE, META_STORE], "readwrite", async (tx) => {
        const stored = await requestResult<CaptureState | undefined>(
          tx.objectStore(STATE_STORE).get(CAPTURE_STATE_KEY),
        );
        const owner = await readOwner(tx.objectStore(META_STORE));
        const transition = compute(stored === undefined ? null : stored);
        if (isThenable(transition)) {
          (transition as unknown as Promise<unknown>).then(undefined, noop);
          throw new TypeError("transact compute must be synchronous");
        }
        const { state, events } = transition;
        if (typeof state !== "object" || state === null || !Array.isArray(events)) {
          throw new TypeError("transact compute must return { state, events }");
        }
        const queuedAt = this.now();
        tx.objectStore(STATE_STORE).put(state, CAPTURE_STATE_KEY);
        const queue = tx.objectStore(QUEUE_STORE);
        for (const event of events) queue.add({ event, owner, queuedAt });
        await this.enforceLimits(tx, queuedAt);
      });
    });
  }

  /** Drops expired and overflowing events, oldest first, and counts them. Returns how many. */
  private async enforceLimits(tx: IDBTransaction, now: number): Promise<number> {
    const queue = tx.objectStore(QUEUE_STORE);
    let removed = 0;

    // Strictly older than the limit: age > maxAge  <=>  queuedAt < now - maxAge.
    const expired = await requestResult(
      queue.index(AGE_INDEX).getAllKeys(IDBKeyRange.upperBound(now - this.limits.maxAgeMs, true)),
    );
    for (const key of expired) queue.delete(key);
    removed += expired.length;

    const total = await requestResult(queue.count());
    const over = total - this.limits.maxEvents;
    if (over > 0) {
      const oldest = await requestResult(queue.getAllKeys(undefined, over));
      for (const key of oldest) queue.delete(key);
      removed += oldest.length;
    }

    if (removed > 0) {
      const meta = tx.objectStore(META_STORE);
      const counters = await this.readCounters(meta);
      meta.put({ ...counters, dropped: counters.dropped + removed }, COUNTERS_KEY);
    }
    return removed;
  }

  private async readCounters(meta: IDBObjectStore): Promise<Counters> {
    const stored = await requestResult<Partial<Counters> | undefined>(meta.get(COUNTERS_KEY));
    return { ...DEFAULT_COUNTERS, ...(stored ?? {}) };
  }

  async peekBatch(limits: BatchLimits = {}): Promise<QueuedEvent[]> {
    const maxEvents = Math.max(1, Math.floor(limits.maxEvents ?? FLUSH_BATCH_MAX_EVENTS));
    const maxBytes = limits.maxBytes ?? FLUSH_BATCH_MAX_BYTES;
    const { owner } = limits;
    const rows = await this.read([QUEUE_STORE], (tx) =>
      owner === undefined
        ? requestResult<QueuedEvent[]>(tx.objectStore(QUEUE_STORE).getAll(undefined, maxEvents))
        : this.collectOwned(tx, owner, maxEvents),
    );
    const batch: QueuedEvent[] = [];
    let bytes = BODY_OVERHEAD_BYTES;
    for (const row of rows) {
      const size = utf8Length(JSON.stringify(row.event)) + (batch.length > 0 ? 1 : 0);
      // The oldest event always goes out, even alone and over budget (never an empty batch).
      if (batch.length > 0 && bytes + size > maxBytes) break;
      bytes += size;
      batch.push(row);
    }
    return batch;
  }

  /** The oldest `max` rows that belong to `owner`, skipping every other row (oldest first). */
  private collectOwned(tx: IDBTransaction, owner: QueueOwner, max: number): Promise<QueuedEvent[]> {
    return new Promise<QueuedEvent[]>((resolve, reject) => {
      const found: QueuedEvent[] = [];
      const request = tx.objectStore(QUEUE_STORE).openCursor();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve(found);
          return;
        }
        const row = cursor.value as QueuedEvent;
        if (sameOwner(row, owner)) found.push(row);
        if (found.length >= max) resolve(found);
        else cursor.continue();
      };
    });
  }

  settle(update: SettleUpdate): Promise<void> {
    return this.write(async () => {
      const db = await this.database();
      await runTransaction(db, [QUEUE_STORE, META_STORE], "readwrite", async (tx) => {
        const queue = tx.objectStore(QUEUE_STORE);
        for (const seq of update.removeSeqs) queue.delete(seq);

        const meta = tx.objectStore(META_STORE);
        const rejected = update.rejected ?? [];
        const ruleDropped = update.ruleDropped ?? 0;
        if (ruleDropped > 0 || rejected.length > 0) {
          const counters = await this.readCounters(meta);
          meta.put(
            {
              ...counters,
              ruleDropped: counters.ruleDropped + ruleDropped,
              rejected: counters.rejected + rejected.length,
            },
            COUNTERS_KEY,
          );
        }
        if (rejected.length > 0) {
          const notes = await requestResult<RejectNote[] | undefined>(meta.get(NOTES_KEY));
          meta.put([...(notes ?? []), ...rejected].slice(-REJECT_NOTES_MAX), NOTES_KEY);
        }
        if (update.sync !== undefined) {
          const current = await requestResult<Partial<SyncMeta> | undefined>(meta.get(SYNC_KEY));
          const changes = Object.fromEntries(
            Object.entries(update.sync).filter(([, value]) => value !== undefined),
          );
          meta.put({ ...DEFAULT_SYNC, ...(current ?? {}), ...changes }, SYNC_KEY);
        }
      });
    });
  }

  async stats(): Promise<QueueStats> {
    return this.read([QUEUE_STORE, META_STORE], async (tx) => {
      const queue = tx.objectStore(QUEUE_STORE);
      const [depth, oldest, counters] = await Promise.all([
        requestResult(queue.count()),
        requestResult<IDBCursorWithValue | null>(queue.openCursor()),
        this.readCounters(tx.objectStore(META_STORE)),
      ]);
      return {
        depth,
        oldestQueuedAt: oldest === null ? null : (oldest.value as QueuedEvent).queuedAt,
        droppedCount: counters.dropped,
        ruleDroppedCount: counters.ruleDropped,
        rejectedCount: counters.rejected,
      };
    });
  }

  async getDroppedCount(): Promise<number> {
    return this.read([META_STORE], async (tx) => {
      return (await this.readCounters(tx.objectStore(META_STORE))).dropped;
    });
  }

  async getMeta(): Promise<{ sync: SyncMeta; rejectedNotes: RejectNote[] }> {
    return this.read([META_STORE], async (tx) => {
      const meta = tx.objectStore(META_STORE);
      const [sync, notes] = await Promise.all([
        requestResult<Partial<SyncMeta> | undefined>(meta.get(SYNC_KEY)),
        requestResult<RejectNote[] | undefined>(meta.get(NOTES_KEY)),
      ]);
      return { sync: { ...DEFAULT_SYNC, ...(sync ?? {}) }, rejectedNotes: notes ?? [] };
    });
  }

  applyLimits(): Promise<number> {
    return this.write(async () => {
      const db = await this.database();
      return runTransaction(db, [QUEUE_STORE, META_STORE], "readwrite", (tx) =>
        this.enforceLimits(tx, this.now()),
      );
    });
  }

  async getOwner(): Promise<QueueOwner | null> {
    return this.read([META_STORE], (tx) => readOwner(tx.objectStore(META_STORE)));
  }

  /** Pure setter: later `transact` commits are stamped with it; no row is cleared or re-stamped. */
  setOwner(owner: QueueOwner): Promise<void> {
    return this.write(async () => {
      const db = await this.database();
      await runTransaction(db, [META_STORE], "readwrite", async (tx) => {
        tx.objectStore(META_STORE).put(
          { serverOrigin: owner.serverOrigin, integrationId: owner.integrationId },
          OWNER_KEY,
        );
      });
    });
  }

  clear(): Promise<number> {
    return this.write(async () => {
      const db = await this.database();
      return runTransaction(db, [QUEUE_STORE], "readwrite", async (tx) => {
        const queue = tx.objectStore(QUEUE_STORE);
        const count = await requestResult(queue.count());
        queue.clear();
        return count;
      });
    });
  }
}

/** The CaptureStore + queue over IndexedDB (see types.ts `QueueStore`). */
export function createIdbCaptureStore(options: CreateStoreOptions): QueueStore {
  return new IdbQueueStore(options);
}
