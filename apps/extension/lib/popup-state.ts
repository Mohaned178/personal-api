// M2-06 popup state selector: one snapshot of connection, pause, queue and counters for the popup.

import type { Connection } from "./connect";
import { getPaused } from "./pause";
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

/** The answer when the queue cannot be read at all: fail closed, show nothing and status "disconnected". */
function unreadableState(): PopupState {
  return {
    connection: "disconnected",
    serverOrigin: null,
    integrationName: null,
    paused: true,
    status: "disconnected",
    queueDepth: 0,
    lastSyncAt: null,
    droppedCount: 0,
    ruleDroppedCount: 0,
    rejectedCount: 0,
  };
}

/** Never rejects; never contains the ingest key. On any failure it answers a non-"collecting" status. */
export async function loadPopupState(deps: PopupStateDeps): Promise<PopupState> {
  try {
    const [connection, sync, paused, stats] = await Promise.all([
      deps.getConnection().catch(() => null),
      deps.flusher.getSyncStatus().catch(() => null),
      getPaused(deps.storage),
      deps.store.stats(),
    ]);

    let connectionState: PopupState["connection"];
    if (sync !== null) connectionState = sync.state;
    else if (connection === null) connectionState = "not_connected";
    else connectionState = "disconnected";

    let status: PopupStatus;
    if (connectionState === "not_connected") status = "not_connected";
    else if (connectionState === "disconnected") status = "disconnected";
    else if (paused) status = "paused";
    else status = "collecting";

    return {
      connection: connectionState,
      serverOrigin: connection?.serverOrigin ?? null,
      integrationName: connection?.integrationName ?? null,
      paused,
      status,
      queueDepth: stats.depth,
      lastSyncAt: sync?.lastSuccessAt ?? null,
      droppedCount: stats.droppedCount,
      ruleDroppedCount: stats.ruleDroppedCount,
      rejectedCount: stats.rejectedCount,
    };
  } catch {
    return unreadableState();
  }
}
