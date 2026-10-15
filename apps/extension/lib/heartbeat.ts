// M2-06 server heartbeat sender. STUB: the implementer replaces the bodies.
// (`buildHeartbeat` in ./queue/heartbeat.ts already builds the request body.)

import type { Connection } from "./connect";
import type { QueueStore } from "./queue";

/** Own alarm, separate from the capture engine's 30 s `pa-heartbeat` and the flush retry alarm. */
export const SERVER_HEARTBEAT_ALARM_NAME = "pa-server-heartbeat";

/** The server only needs a sign of life now and then; 5 minutes. */
export const SERVER_HEARTBEAT_PERIOD_MINUTES = 5;

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

export function createHeartbeatSender(_deps: HeartbeatDeps): HeartbeatSender {
  throw new Error("not implemented");
}
