/** M1-03 (test-writer stub). The builder replaces the bodies; signatures are pinned by the tests. */

export type ApiKeyKind = "ingest" | "read";

export interface GeneratedApiKey {
  /** The full key, shown to the user once. Never stored. */
  plaintext: string;
  /** Short, display-only leading part of `plaintext` (for identifying a key in a list). */
  prefix: string;
  /** Lowercase hex SHA-256 of `plaintext`. This is what the database stores and looks up. */
  hash: string;
}

/** `pa_ing_` / `pa_read_` + base64url (no padding) of 32 random bytes. */
export function generateApiKey(_kind: ApiKeyKind): GeneratedApiKey {
  throw new Error("not implemented: generateApiKey");
}

/** Lowercase hex SHA-256 of the presented key. */
export function hashApiKey(_plaintext: string): string {
  throw new Error("not implemented: hashApiKey");
}
