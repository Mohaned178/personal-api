// M2-06 server heartbeat sender: POST /v1/ingest/heartbeat on its own periodic alarm.
// (`buildHeartbeat` in ./queue/heartbeat.ts already builds the request body.)

import type { Connection } from "./connect";
import type { QueueStore } from "./queue";
import { FLUSH_REQUEST_TIMEOUT_MS } from "./queue/constants";
import { buildHeartbeat } from "./queue/heartbeat";
import { keyMarker } from "./queue/key-marker";

/** Own alarm, separate from the capture engine's 30 s `pa-heartbeat` and the flush retry alarm. */
export const SERVER_HEARTBEAT_ALARM_NAME = "pa-server-heartbeat";

/** The server only needs a sign of life now and then; 5 minutes. */
export const SERVER_HEARTBEAT_PERIOD_MINUTES = 5;

/** Reported as `clientVersion` in every heartbeat (the extension version). */
export const CLIENT_VERSION = "0.1.0";

export type HeartbeatStatus = "sent" | "not_connected" | "disconnected" | "failed";

export interface HeartbeatDeps {
  store: Pick<QueueStore, "applyLimits" | "stats" | "getMeta">;
  /** The stored connection, or `null` (nothing is sent). */
  getConnection(): Promise<Connection | null>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  };
  now(): number;
  clientVersion: string;
}

export interface HeartbeatSender {
  /** POST the heartbeat once. NEVER rejects and never logs. */
  send(): Promise<{ status: HeartbeatStatus }>;
  /** Every background start: creates the periodic alarm if it does not exist yet. Never rejects. */
  start(): Promise<void>;
  /** Sends for `SERVER_HEARTBEAT_ALARM_NAME` (returns the promise, for Firefox); `undefined` otherwise. */
  onAlarm(alarm: { name: string }): Promise<void> | undefined;
}

/** Frees the connection of a response whose body is not read (best effort, never throws). */
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: freeing the connection only.
  }
}

export function createHeartbeatSender(deps: HeartbeatDeps): HeartbeatSender {
  async function send(): Promise<{ status: HeartbeatStatus }> {
    try {
      const connection = await deps.getConnection();
      if (connection === null) return { status: "not_connected" };

      // A 401 was received for exactly this key: stay silent until a different key is stored.
      const { sync } = await deps.store.getMeta();
      if (
        sync.state === "disconnected" &&
        sync.disconnectedFor === (await keyMarker(connection.ingestKey))
      ) {
        return { status: "disconnected" };
      }

      // Counts only: no event data ever goes into the body (invariant 6).
      const body = await buildHeartbeat(deps.store, {
        now: deps.now,
        clientVersion: deps.clientVersion,
      });
      const response = await deps.fetch(`${connection.serverOrigin}/v1/ingest/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.ingestKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(FLUSH_REQUEST_TIMEOUT_MS),
      });
      discard(response);
      // The sync state is the flusher's: a failed heartbeat changes nothing (it is not evidence
      // about the ingest key; the next periodic send simply tries again).
      return { status: response.ok ? "sent" : "failed" };
    } catch {
      // Fail closed and silent: nothing was sent, nothing is written, nothing is logged.
      return { status: "failed" };
    }
  }

  async function start(): Promise<void> {
    try {
      const existing = await deps.alarms.get(SERVER_HEARTBEAT_ALARM_NAME);
      if (!existing) {
        await deps.alarms.create(SERVER_HEARTBEAT_ALARM_NAME, {
          periodInMinutes: SERVER_HEARTBEAT_PERIOD_MINUTES,
        });
      }
    } catch {
      // Never rejects: the next background start tries again.
    }
  }

  function onAlarm(alarm: { name: string }): Promise<void> | undefined {
    if (alarm.name !== SERVER_HEARTBEAT_ALARM_NAME) return undefined;
    return send().then(() => undefined);
  }

  return { send, start, onAlarm };
}
