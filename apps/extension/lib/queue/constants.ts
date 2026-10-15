// M2-05 persistent queue and sync: the numbers the tests pin. Changing one is a contract change
// (docs/PLAN.md section 7, ADR 0002) and needs the tests and the plan updated with it.

import { INGEST_MAX_BATCH_BYTES, INGEST_MAX_BATCH_EVENTS } from "@personal-api/contracts";
import { HEARTBEAT_ALARM_NAME } from "../capture/constants";

/** The queue and the capture state share this one IndexedDB database (ADR 0002 decision 1). */
export const QUEUE_DB_NAME = "personal-api";

/** The queue holds at most this many events; overflow drops the OLDEST first (PLAN section 7). */
export const MAX_QUEUE_EVENTS = 50_000;

/** An event queued for longer than this (strictly) is dropped, oldest first (PLAN section 7). */
export const MAX_QUEUE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** One request carries at most this many events and this many body bytes (PLAN section 6). */
export const FLUSH_BATCH_MAX_EVENTS = INGEST_MAX_BATCH_EVENTS;
export const FLUSH_BATCH_MAX_BYTES = INGEST_MAX_BATCH_BYTES;

/** One-shot alarm that re-runs the flush once a backoff has elapsed (`{ when }`, never periodic). */
export const FLUSH_RETRY_ALARM_NAME = "pa-flush-retry";

/**
 * The alarms that run a flush: the capture engine's 30 s heartbeat alarm (ADR 0002 decision 7:
 * the flush doubles as the heartbeat tick) and the one-shot retry alarm. The flush NEVER creates,
 * changes or clears the heartbeat alarm: stretching it would starve the capture engine's
 * `lastAliveAt` (GAP_MS is 90 s).
 */
export const FLUSH_ALARM_NAMES: readonly string[] = [HEARTBEAT_ALARM_NAME, FLUSH_RETRY_ALARM_NAME];

/** Failure `n` (1-based) waits `min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(n-1))` plus jitter. */
export const BACKOFF_BASE_MS = 30_000; // alarms cannot fire sooner than 30 s
export const BACKOFF_CAP_MS = 15 * 60 * 1000;
/** Jitter adds `random() * BACKOFF_JITTER_RATIO * delay` on top (never subtracts). */
export const BACKOFF_JITTER_RATIO = 0.25;

/** A server `Retry-After` is honoured up to this long. */
export const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

/** Locally kept notes about removed (rejected) events; older notes are evicted first. */
export const REJECT_NOTES_MAX = 100;

/** Each request is aborted (and counted as a network failure) after this long. */
export const FLUSH_REQUEST_TIMEOUT_MS = 20_000;
