// M2-06 popup state selector. STUB: the implementer replaces the body.

import type { Connection } from "./connect";
import type { Flusher, QueueStore } from "./queue";

export type PopupStatus = "not_connected" | "disconnected" | "paused" | "collecting";

export interface PopupState {
  /** The sync state, from `Flusher.getSyncStatus().state`. */
  connection: "not_connected" | "connected" | "disconnected";
  serverOrigin: string | null;
  integrationName: string | null;
  paused: boolean;
  /** Precedence: not_connected > disconnected > paused > collecting. */
  status: PopupStatus;
  queueDepth: number;
  /** `SyncStatus.lastSuccessAt` (epoch ms), or null = never. */
  lastSyncAt: number | null;
  /** Events dropped locally by the 50k / 14-day cap (the same number the heartbeat reports). */
  droppedCount: number;
  /** Events a server collect rule dropped. */
  ruleDroppedCount: number;
  /** Events removed with a rejection note. */
  rejectedCount: number;
}

export interface PopupStateDeps {
  getConnection(): Promise<Connection | null>;
  flusher: Pick<Flusher, "getSyncStatus">;
  store: Pick<QueueStore, "stats">;
  storage: { get(key: string): Promise<Record<string, unknown>> };
}

/** Never rejects; never contains the ingest key. On any failure it answers a non-"collecting" status. */
export function loadPopupState(_deps: PopupStateDeps): Promise<PopupState> {
  return Promise.reject(new Error("not implemented"));
}
