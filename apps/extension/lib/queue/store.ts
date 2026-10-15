import type { CreateStoreOptions, QueueStore } from "./types";

/** M2-05: the CaptureStore + queue over IndexedDB (see types.ts `QueueStore`). Not implemented. */
export function createIdbCaptureStore(_options: CreateStoreOptions): QueueStore {
  throw new Error("not implemented");
}
