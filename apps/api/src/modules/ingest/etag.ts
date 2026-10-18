import { createHash } from "node:crypto";

/** A strong ETag for a JSON-serializable body: a quoted, URL-safe digest of its JSON text. */
export function etagOf(body: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("base64url");
  return `"${digest.slice(0, 27)}"`;
}

/**
 * Whether an `If-None-Match` header matches `etag`. Weak comparison (RFC 9110 §13.1.2): a `W/`
 * prefix is ignored, a comma-separated list matches when any entry does, and `*` matches anything.
 * An absent or empty header never matches.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const wanted = stripWeak(etag);
  return header.split(",").some((entry) => {
    const candidate = entry.trim();
    return candidate === "*" || (candidate !== "" && stripWeak(candidate) === wanted);
  });
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}
