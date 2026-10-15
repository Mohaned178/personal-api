// M2-05 persistent queue and sync: the public surface the tests rely on. The implementer may add
// members and files, but must not change or remove what is declared here.

import type {
  CaptureBrowserApi,
  CapturedEvent,
  CaptureEngine,
  CaptureGate,
  CaptureListenerApi,
  CaptureStore,
} from "../capture";
import type { Connection } from "../connect";

/**
 * Who the queued events belong to: the server and the integration they were captured for. Events
 * queued for one owner must never be sent to another (privacy: M2-R fix).
 */
export interface QueueOwner {
  /** Canonical origin, as in `Connection.serverOrigin`. */
  serverOrigin: string;
  integrationId: string;
}

/** A queued event as stored. `seq` is the insertion order (oldest = smallest). */
export interface QueuedEvent {
  seq: number;
  /** Exactly the event the capture engine handed to `transact` (same id, same data; no extra keys). */
  event: CapturedEvent;
  /**
   * The store's owner when the event was committed (`null` = none was set). Only rows whose
   * owner equals the current connection's owner are ever flushed.
   */
  owner?: QueueOwner | null;
  /** `now()` of the store when the event was committed. The 14-day cap counts from here. */
  queuedAt: number;
}

export interface BatchLimits {
  /** Default FLUSH_BATCH_MAX_EVENTS. */
  maxEvents?: number;
  /** Default FLUSH_BATCH_MAX_BYTES. Counted as the UTF-8 length of `JSON.stringify({ events })`. */
  maxBytes?: number;
  /**
   * When given, only rows whose owner equals this one are returned (a row without an owner never
   * matches). The flusher always passes the current connection's owner. Omitted = every row.
   */
  owner?: QueueOwner;
}

export interface QueueLimits {
  maxEvents: number;
  maxAgeMs: number;
}

/** A payload-free note about an event that was removed without being stored by the server. */
export interface RejectNote {
  /** The event id (never a URL, domain, path or any payload). */
  id: string;
  /** A server `ingest.*` rejection code, or `client.event_invalid` for an event that failed local validation. */
  code: string;
  /** `now()` when the note was recorded. */
  at: number;
}

export type FailureKind = "network" | "server" | "rate_limited" | "bad_response" | "client_error";

/** Persisted sync state (survives a background kill). */
export interface SyncMeta {
  /** `disconnected` after a 401, until a different ingest key is stored. */
  state: "connected" | "disconnected";
  consecutiveFailures: number;
  /** No request is made before this time (epoch ms). `null` = no backoff. */
  nextAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailure: FailureKind | null;
  /** Opaque marker of the key that was refused; never the key itself. */
  disconnectedFor: string | null;
}

export interface QueueStats {
  depth: number;
  /** `queuedAt` of the oldest queued event; `null` when empty. */
  oldestQueuedAt: number | null;
  /** Events dropped locally by the cap (50k) or the age limit (14 days). Persisted, reported in the heartbeat. */
  droppedCount: number;
  /** Events the server answered `dropped` (a collect rule said no). Never retried. */
  ruleDroppedCount: number;
  /** Events removed with a rejection note (server per-item `rejected`, or failed local validation). */
  rejectedCount: number;
}

/** Everything a flush decides about a batch, applied in ONE readwrite transaction. */
export interface SettleUpdate {
  /** Delete these rows by `seq`. A `seq` that no longer exists (for example capped meanwhile) is ignored. */
  removeSeqs: readonly number[];
  /** Added to `ruleDroppedCount`. */
  ruleDropped?: number;
  /** Each note is appended (newest last) and counts once in `rejectedCount`. */
  rejected?: readonly RejectNote[];
  /** Shallow-merged into the persisted `SyncMeta`. */
  sync?: Partial<SyncMeta>;
}

export interface CreateStoreOptions {
  /** Default `globalThis.indexedDB`. Tests pass a fresh fake factory per "disk". */
  indexedDB?: IDBFactory;
  /** Default QUEUE_DB_NAME. */
  dbName?: string;
  /** Epoch milliseconds. Stamps `queuedAt` and measures the age cap. */
  now: () => number;
  /** Defaults MAX_QUEUE_EVENTS and MAX_QUEUE_AGE_MS. */
  limits?: Partial<QueueLimits>;
}

/**
 * The durable store: the capture engine's `CaptureStore` plus the queue operations, over ONE
 * IndexedDB database (state, queue and meta). Every readwrite transaction uses
 * `durability: "strict"` (ADR 0002 decision 10).
 */
export interface QueueStore extends CaptureStore {
  /** The oldest events first, within `limits`. Always at least one event when the queue is not empty. Read-only. */
  peekBatch(limits?: BatchLimits): Promise<QueuedEvent[]>;
  /** Applies `update` in one readwrite transaction: all or nothing. */
  settle(update: SettleUpdate): Promise<void>;
  stats(): Promise<QueueStats>;
  getDroppedCount(): Promise<number>;
  getMeta(): Promise<{ sync: SyncMeta; rejectedNotes: RejectNote[] }>;
  /** Drops events older than the age limit (counted in `droppedCount`). Returns how many. `transact` does this too. */
  applyLimits(): Promise<number>;
  /** The owner that new events are stamped with, or `null` when none was set. */
  getOwner(): Promise<QueueOwner | null>;
  /** Pure setter: later `transact` commits are stamped with `owner`. It never clears or re-stamps rows. */
  setOwner(owner: QueueOwner): Promise<void>;
  /** Deletes every queued event (user action; not counted as dropped). Returns how many. */
  clear(): Promise<number>;
  /**
   * Closes the connection (idempotent). A killed worker never calls it; tests use it to cut off a
   * "dead" instance. After it, every operation of this store rejects and writes nothing.
   */
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// flush

export interface FlushAlarms {
  /** Only ever called with `FLUSH_RETRY_ALARM_NAME` and `{ when }`. */
  create(name: string, info: { when: number }): Promise<void> | void;
  clear(name: string): Promise<boolean | undefined | void> | boolean | undefined | void;
}

export interface FlushDeps {
  store: QueueStore;
  /** The stored connection, or `null` (fails closed). Read on every flush. */
  getConnection(): Promise<Connection | null>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  alarms: FlushAlarms;
  now(): number;
  /** In [0, 1). */
  random(): number;
}

/**
 * How a flush run ended:
 * - `drained`: nothing is left to send (including: it was empty to begin with);
 * - `backoff`: waiting (a failure was just recorded, or the backoff has not elapsed yet);
 * - `disconnected`: a 401 was received (now or earlier) for the current ingest key;
 * - `not_connected`: there is no stored connection.
 */
export type FlushStatus = "drained" | "backoff" | "disconnected" | "not_connected";

export interface FlushResult {
  status: FlushStatus;
}

export interface SyncStatus {
  state: "connected" | "disconnected" | "not_connected";
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailure: FailureKind | null;
}

export interface Flusher {
  /**
   * One flush run: sends batches oldest-first until the queue is empty or something stops it.
   * NEVER rejects and NEVER makes two requests at once: a call made while a run is in flight
   * resolves only after a run that started after the call (so events committed before the call
   * are covered).
   */
  flush(): Promise<FlushResult>;
  /** Every background start: re-arms the retry alarm from the persisted backoff. Never rejects. */
  start(): Promise<void>;
  /** Runs a flush for `FLUSH_ALARM_NAMES` (returns its promise, for Firefox); `undefined` for any other alarm. */
  onAlarm(alarm: { name: string }): Promise<void> | undefined;
  /** The user's "clear local queue": deletes every queued event, keeps the counters and the sync state. */
  clearQueue(): Promise<number>;
  getSyncStatus(): Promise<SyncStatus>;
}

// ---------------------------------------------------------------------------------------------
// wiring

/** The `browser.*` subset the background wiring uses. WXT's real `browser` must be assignable to it. */
export type BackgroundBrowserApi = CaptureBrowserApi &
  CaptureListenerApi & {
    alarms: FlushAlarms;
    storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  };

export interface BackgroundDeps {
  browser: BackgroundBrowserApi;
  store: QueueStore;
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  random(): number;
  newId(): string;
  newTabRef(): string;
  /**
   * The rule gate. When omitted, the wiring falls back to the M2-07 temporary allow list in
   * `browser.storage.local` (read-only); an explicit gate wins (tests, later milestones). Deny by
   * default either way (invariant 1).
   */
  collectGate?: CaptureGate;
}

export interface WiredBackground {
  engine: CaptureEngine;
  flusher: Flusher;
  /** The gate the engine uses: connected AND not disconnected AND `collectGate` allows (anything but `true` denies). */
  gate: CaptureGate;
  /** Settles (never rejects) once `engine.start()` and `flusher.start()` have settled. */
  ready: Promise<void>;
}
