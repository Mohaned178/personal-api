import { createHash, randomBytes } from "node:crypto";

export interface GeneratedApiKey {
  /** The full key, shown to the user once. Never stored. */
  plaintext: string;
  /** Short, display-only leading part of `plaintext` (for identifying a key in a list). */
  prefix: string;
  /** Lowercase hex SHA-256 of `plaintext`. This is what the database stores and looks up. */
  hash: string;
}

export const INGEST_KEY_MARKER = "pa_ing_";

/** Random bytes per key: 256 bits, encoded as 43 base64url characters. */
const KEY_BYTES = 32;

/** Secret characters kept in the display prefix: enough to tell keys apart, ~36 of 256 bits. */
const PREFIX_SECRET_CHARS = 6;

/** The exact shape of an ingest key. Anything else is rejected before it is hashed or looked up. */
export const INGEST_KEY_PATTERN = /^pa_ing_[A-Za-z0-9_-]{43}$/;

/** `pa_ing_` + base64url (no padding) of 32 random bytes. */
export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${INGEST_KEY_MARKER}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, INGEST_KEY_MARKER.length + PREFIX_SECRET_CHARS),
    hash: hashApiKey(plaintext),
  };
}

/** Lowercase hex SHA-256 of the presented key. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
