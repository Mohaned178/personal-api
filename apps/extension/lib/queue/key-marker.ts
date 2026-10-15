/**
 * An opaque, non-reversible marker of an ingest key (never the key itself). The flusher writes it
 * with the `disconnected` sync state and the heartbeat sender compares it, so both must use the
 * same algorithm.
 */
export async function keyMarker(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}
