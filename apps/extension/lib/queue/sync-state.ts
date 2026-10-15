import type { Connection } from "../connect";
import { keyMarker } from "./key-marker";
import type { SyncMeta, SyncStatus } from "./types";

/**
 * The sync state of a stored connection: `not_connected` without one, `disconnected` when the
 * server refused (401) exactly this ingest key, otherwise `connected`. The key is hashed only when
 * the stored state is `disconnected`, so the common case costs nothing.
 */
export async function connectionState(
  connection: Connection | null,
  sync: Pick<SyncMeta, "state" | "disconnectedFor">,
): Promise<SyncStatus["state"]> {
  if (connection === null) return "not_connected";
  if (
    sync.state === "disconnected" &&
    sync.disconnectedFor === (await keyMarker(connection.ingestKey))
  ) {
    return "disconnected";
  }
  return "connected";
}
