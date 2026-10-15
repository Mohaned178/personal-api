import type { HeartbeatRequest } from "@personal-api/contracts";
import type { QueueStore } from "./types";

/**
 * The body of `POST /v1/ingest/heartbeat` (M2-06 sends it): applies the age limit first, then
 * `queueDepth` = depth, `oldestQueuedAgeMs` = max(0, now - oldestQueuedAt) or 0 when empty,
 * `droppedCount` = the persisted cap/age drop counter (not rule drops). Counts only: no event
 * data ever goes into it.
 */
export async function buildHeartbeat(
  store: Pick<QueueStore, "applyLimits" | "stats">,
  options: { now: () => number; clientVersion: string },
): Promise<HeartbeatRequest> {
  await store.applyLimits();
  const stats = await store.stats();
  const age =
    stats.oldestQueuedAt === null
      ? 0
      : Math.max(0, Math.floor(options.now() - stats.oldestQueuedAt));
  return {
    queueDepth: stats.depth,
    oldestQueuedAgeMs: age,
    droppedCount: stats.droppedCount,
    clientVersion: options.clientVersion,
  };
}
