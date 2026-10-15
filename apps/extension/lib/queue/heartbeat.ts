import type { HeartbeatRequest } from "@personal-api/contracts";
import type { QueueStore } from "./types";

/**
 * The body of `POST /v1/ingest/heartbeat` (M2-06 sends it): applies the age limit first, then
 * `queueDepth` = depth, `oldestQueuedAgeMs` = max(0, now - oldestQueuedAt) or 0 when empty,
 * `droppedCount` = the persisted cap/age drop counter (not rule drops). Not implemented.
 */
export function buildHeartbeat(
  _store: Pick<QueueStore, "applyLimits" | "stats">,
  _options: { now: () => number; clientVersion: string },
): Promise<HeartbeatRequest> {
  throw new Error("not implemented");
}
