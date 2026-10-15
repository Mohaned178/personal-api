import {
  type IngestBatchResponse,
  ingestBatchResponseSchema,
  parseEvent,
} from "@personal-api/contracts";
import type { Connection } from "../connect";
import { backoffDelayMs } from "./backoff";
import {
  FLUSH_ALARM_NAMES,
  FLUSH_REQUEST_TIMEOUT_MS,
  FLUSH_RETRY_ALARM_NAME,
  RETRY_AFTER_MAX_MS,
} from "./constants";
import { keyMarker } from "./key-marker";
import { connectionState } from "./sync-state";
import type {
  FailureKind,
  FlushDeps,
  Flusher,
  FlushResult,
  QueuedEvent,
  RejectNote,
  SyncMeta,
  SyncStatus,
} from "./types";

/** Code of a note for an event that failed validation before it was ever sent. */
const CLIENT_EVENT_INVALID = "client.event_invalid";

/** `Retry-After` as milliseconds from `now`: delta-seconds or an HTTP date; `null` if unreadable. */
function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: freeing the connection only.
  }
}

/** The outcome of one request, before anything is written. */
type Attempt =
  | { kind: "results"; response: IngestBatchResponse }
  | { kind: "unauthorized" }
  | { kind: "resize" }
  | { kind: "failure"; failure: FailureKind; retryAfterMs: number | null };

/** Batch flush with per-item result handling, backoff and the disconnected state. */
export function createFlusher(deps: FlushDeps): Flusher {
  const { store, alarms } = deps;

  async function readConnection(): Promise<Connection | null> {
    try {
      return await deps.getConnection();
    } catch {
      return null;
    }
  }

  async function sendBatch(connection: Connection, rows: QueuedEvent[]): Promise<Attempt> {
    let response: Response;
    try {
      response = await deps.fetch(`${connection.serverOrigin}/v1/ingest/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.ingestKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: rows.map((row) => row.event) }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(FLUSH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { kind: "failure", failure: "network", retryAfterMs: null };
    }

    const status = response.status;
    if (status === 401) {
      discard(response);
      return { kind: "unauthorized" };
    }
    if (status === 400 || status === 413) {
      discard(response);
      return rows.length > 1
        ? { kind: "resize" }
        : { kind: "failure", failure: "client_error", retryAfterMs: null };
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), deps.now());
      discard(response);
      const failure: FailureKind =
        status === 429 ? "rate_limited" : status >= 500 ? "server" : "client_error";
      return { kind: "failure", failure, retryAfterMs };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "failure", failure: "bad_response", retryAfterMs: null };
    }
    const parsed = ingestBatchResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.results.length !== rows.length) {
      return { kind: "failure", failure: "bad_response", retryAfterMs: null };
    }
    // Results are positional; every one must name the event it answers, or nothing is deleted.
    const aligned = parsed.data.results.every(
      (result, index) => result.id === rows[index]?.event.id,
    );
    return aligned
      ? { kind: "results", response: parsed.data }
      : { kind: "failure", failure: "bad_response", retryAfterMs: null };
  }

  async function recordFailure(
    meta: SyncMeta,
    failure: FailureKind,
    retryAfterMs: number | null,
  ): Promise<FlushResult> {
    const failures = meta.consecutiveFailures + 1;
    let delay = backoffDelayMs(failures, deps.random);
    if (retryAfterMs !== null) delay = Math.max(delay, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS));
    const when = deps.now() + delay;
    await store.settle({
      removeSeqs: [],
      sync: { consecutiveFailures: failures, nextAttemptAt: when, lastFailure: failure },
    });
    try {
      await alarms.create(FLUSH_RETRY_ALARM_NAME, { when });
    } catch {
      // The heartbeat alarm still runs a flush once the backoff has elapsed.
    }
    return { status: "backoff" };
  }

  async function clearRetryAlarm(): Promise<void> {
    try {
      await alarms.clear(FLUSH_RETRY_ALARM_NAME);
    } catch {
      // Nothing to do: a stale alarm only runs a harmless flush.
    }
  }

  async function runOnce(): Promise<FlushResult> {
    const connection = await readConnection();
    if (connection === null) return { status: "not_connected" };

    const marker = await keyMarker(connection.ingestKey);
    let { sync: meta } = await store.getMeta();
    if (meta.state === "disconnected") {
      if (meta.disconnectedFor === marker) return { status: "disconnected" };
      // A different ingest key was stored since the 401: start over with it.
      const resumed: Partial<SyncMeta> = {
        state: "connected",
        disconnectedFor: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        lastFailure: null,
      };
      await store.settle({ removeSeqs: [], sync: resumed });
      meta = { ...meta, ...resumed } as SyncMeta;
    }

    if (meta.nextAttemptAt !== null && deps.now() < meta.nextAttemptAt) {
      return { status: "backoff" };
    }

    await store.applyLimits();

    let maxEvents: number | undefined;
    for (;;) {
      // Only rows queued for THIS server and integration may go out with this key.
      const rows = await store.peekBatch({
        owner: { serverOrigin: connection.serverOrigin, integrationId: connection.integrationId },
        ...(maxEvents === undefined ? {} : { maxEvents }),
      });
      if (rows.length === 0) return { status: "drained" };

      // Nothing that fails the contract ever leaves the browser (for example a query string).
      const invalid = rows.filter((row) => !parseEvent(row.event).ok);
      if (invalid.length > 0) {
        const at = deps.now();
        const notes: RejectNote[] = invalid.map((row) => ({
          id: row.event.id,
          code: CLIENT_EVENT_INVALID,
          at,
        }));
        await store.settle({ removeSeqs: invalid.map((row) => row.seq), rejected: notes });
        continue;
      }

      const attempt = await sendBatch(connection, rows);
      switch (attempt.kind) {
        case "unauthorized":
          await store.settle({
            removeSeqs: [],
            sync: { state: "disconnected", disconnectedFor: marker, nextAttemptAt: null },
          });
          await clearRetryAlarm();
          return { status: "disconnected" };
        case "resize":
          maxEvents = Math.floor(rows.length / 2);
          continue;
        case "failure":
          return recordFailure(meta, attempt.failure, attempt.retryAfterMs);
        case "results": {
          const at = deps.now();
          const removeSeqs: number[] = [];
          const rejected: RejectNote[] = [];
          let ruleDropped = 0;
          attempt.response.results.forEach((result, index) => {
            removeSeqs.push((rows[index] as QueuedEvent).seq);
            if (result.status === "dropped") ruleDropped++;
            else if (result.status === "rejected") {
              rejected.push({ id: (rows[index] as QueuedEvent).event.id, code: result.code, at });
            }
          });
          const hadBackoff = meta.nextAttemptAt !== null;
          await store.settle({
            removeSeqs,
            ruleDropped,
            rejected,
            sync: {
              state: "connected",
              disconnectedFor: null,
              consecutiveFailures: 0,
              nextAttemptAt: null,
              lastSuccessAt: at,
              lastFailure: null,
            },
          });
          meta = {
            ...meta,
            consecutiveFailures: 0,
            nextAttemptAt: null,
            lastSuccessAt: at,
            lastFailure: null,
          };
          if (hadBackoff) await clearRetryAlarm();
          break;
        }
      }
    }
  }

  async function run(): Promise<FlushResult> {
    try {
      return await runOnce();
    } catch {
      // Fail closed and silent: the queue is untouched, the next alarm tries again. Nothing is
      // logged or returned about the cause (it could name a key, URL or domain).
      return { status: "backoff" };
    }
  }

  // Single flight: a call made while a run is in flight waits for the NEXT run, which starts after
  // the call and therefore covers every event committed before it.
  let running = false;
  let waiting: ((result: FlushResult) => void)[] = [];

  async function pump(): Promise<void> {
    running = true;
    try {
      while (waiting.length > 0) {
        const batch = waiting;
        waiting = [];
        const result = await run();
        for (const resolve of batch) resolve(result);
      }
    } finally {
      running = false;
    }
  }

  function flush(): Promise<FlushResult> {
    return new Promise<FlushResult>((resolve) => {
      waiting.push(resolve);
      if (!running) void pump();
    });
  }

  async function start(): Promise<void> {
    try {
      const { sync } = await store.getMeta();
      if (sync.state !== "disconnected" && sync.nextAttemptAt !== null) {
        await alarms.create(FLUSH_RETRY_ALARM_NAME, { when: sync.nextAttemptAt });
      }
    } catch {
      // The heartbeat alarm still triggers a flush.
    }
  }

  function onAlarm(alarm: { name: string }): Promise<void> | undefined {
    if (!FLUSH_ALARM_NAMES.includes(alarm.name)) return undefined;
    return flush().then(() => undefined);
  }

  async function getSyncStatus(): Promise<SyncStatus> {
    const connection = await readConnection();
    const { sync } = await store.getMeta();
    return {
      state: await connectionState(connection, sync),
      consecutiveFailures: sync.consecutiveFailures,
      nextAttemptAt: sync.nextAttemptAt,
      lastSuccessAt: sync.lastSuccessAt,
      lastFailure: sync.lastFailure,
    };
  }

  return {
    flush,
    start,
    onAlarm,
    clearQueue: () => store.clear(),
    getSyncStatus,
  };
}
