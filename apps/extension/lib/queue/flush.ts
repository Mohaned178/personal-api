import type { Flusher, FlushDeps } from "./types";

/** M2-05: batch flush with per-item result handling, backoff and disconnect. Not implemented. */
export function createFlusher(_deps: FlushDeps): Flusher {
  throw new Error("not implemented");
}
