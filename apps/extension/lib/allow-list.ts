// M2-07 temporary domain allow list (removed in M4-06). STUB: the builder implements this.
import type { CaptureGate } from "./capture";

/** `browser.storage.local` key holding the list (a string array of normalized hostnames). */
export const ALLOW_LIST_STORAGE_KEY = "allowList";
/** Max entries; adding beyond it throws. */
export const MAX_ALLOW_LIST_ENTRIES = 200;

export interface AllowListStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const NOT_IMPLEMENTED = "not implemented";

/**
 * Lowercase, trim, strip one trailing dot. Returns null for anything that is not a plain hostname
 * (URLs, paths, ports, wildcards, userinfo, spaces, empty labels, empty, over 253 chars).
 */
export function normalizeAllowedDomain(_input: unknown): string | null {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The stored list. [] when absent. FAIL CLOSED: [] when the value is not an array of valid,
 * already-normalized strings, or when the read throws.
 */
export async function getAllowList(_storage: AllowListStorage): Promise<string[]> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Adds one domain (normalized, de-duplicated). Returns the new list. Rejects and stores nothing for an invalid domain or beyond MAX_ALLOW_LIST_ENTRIES. */
export async function addAllowedDomain(
  _storage: AllowListStorage,
  _input: string,
): Promise<string[]> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Removes one domain (normalized compare). Removing an absent one is a no-op. Returns the new list. */
export async function removeAllowedDomain(
  _storage: AllowListStorage,
  _input: string,
): Promise<string[]> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Pure: true only when `domain` equals an entry exactly (case-insensitive). No subdomain matching. */
export function isDomainAllowed(_list: readonly string[], _domain: string): boolean {
  throw new Error(NOT_IMPLEMENTED);
}

/** Gate: true only for a non-null page whose domain is on the stored list, read fresh on every call. Never throws; any failure is false. */
export function createAllowListGate(_storage: AllowListStorage): CaptureGate {
  throw new Error(NOT_IMPLEMENTED);
}
