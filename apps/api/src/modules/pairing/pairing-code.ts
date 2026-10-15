import { createHash, randomBytes } from "node:crypto";

/**
 * Crockford base32: no I, L, O or U, so a code read off a screen and typed into a popup survives
 * the usual mix-ups. 32 symbols, so a random byte masked to 5 bits is uniform (no modulo bias).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 symbols x 5 bits = 100 bits of entropy. */
const CODE_LENGTH = 20;
const GROUP_SIZE = 4;

/** The normalized shape of a code. Anything else is rejected before it is hashed or looked up. */
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;

export interface GeneratedPairingCode {
  /** What the user sees and types: `XXXX-XXXX-XXXX-XXXX-XXXX`. Shown once, never stored. */
  display: string;
  /** Lowercase hex SHA-256 of the normalized code. This is what the database stores. */
  hash: string;
}

export function generatePairingCode(): GeneratedPairingCode {
  const bytes = randomBytes(CODE_LENGTH);
  let normalized = "";
  for (const byte of bytes) normalized += ALPHABET[byte & 31];
  const groups = normalized.match(new RegExp(`.{${GROUP_SIZE}}`, "g")) ?? [];
  return { display: groups.join("-"), hash: hashPairingCode(normalized) };
}

/**
 * Trims, upper-cases, drops dashes and spaces, and reads the look-alikes the way Crockford does
 * (O as 0, I and L as 1). Returns null unless the result has the exact shape of a code.
 */
export function normalizePairingCode(presented: unknown): string | null {
  if (typeof presented !== "string" || presented.length > 64) return null;
  const normalized = presented
    .toUpperCase()
    .replaceAll(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replaceAll(/[IL]/g, "1");
  return PAIRING_CODE_PATTERN.test(normalized) ? normalized : null;
}

/** Lowercase hex SHA-256 of an already normalized code. */
export function hashPairingCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
