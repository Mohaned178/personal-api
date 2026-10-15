// M2-07 temporary domain allow list (removed in M4-06). Deny by default, fail closed (invariant 1).
import { domainSchema } from "@personal-api/contracts";
import type { CaptureGate } from "./capture";

/** `browser.storage.local` key holding the list (a string array of normalized hostnames). */
export const ALLOW_LIST_STORAGE_KEY = "allowList";
/** Max entries; adding beyond it throws. */
export const MAX_ALLOW_LIST_ENTRIES = 200;

export interface AllowListStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Lowercase, trim, strip one trailing dot. Returns null for anything that is not a plain hostname
 * (URLs, paths, ports, wildcards, userinfo, spaces, empty labels, empty, over 253 chars).
 * The survivors are exactly what `sanitizeUrl` produces for an event's `domain` (same schema).
 */
export function normalizeAllowedDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let candidate = input.trim().toLowerCase();
  if (candidate.endsWith(".")) candidate = candidate.slice(0, -1);
  return domainSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * The stored list. [] when absent. FAIL CLOSED: [] when the value is not an array of valid,
 * already-normalized strings, or when the read throws.
 */
export async function getAllowList(storage: AllowListStorage): Promise<string[]> {
  try {
    const stored = await storage.get(ALLOW_LIST_STORAGE_KEY);
    const value: unknown = stored[ALLOW_LIST_STORAGE_KEY];
    if (!Array.isArray(value) || value.length > MAX_ALLOW_LIST_ENTRIES) return [];
    const list: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || normalizeAllowedDomain(entry) !== entry) return [];
      list.push(entry);
    }
    return list;
  } catch {
    return [];
  }
}

/** Adds one domain (normalized, de-duplicated). Returns the new list. Rejects and stores nothing for an invalid domain or beyond MAX_ALLOW_LIST_ENTRIES. */
export async function addAllowedDomain(
  storage: AllowListStorage,
  input: string,
): Promise<string[]> {
  const domain = normalizeAllowedDomain(input);
  if (domain === null) throw new Error("Not a valid domain");
  const list = await getAllowList(storage);
  if (list.includes(domain)) return list;
  if (list.length >= MAX_ALLOW_LIST_ENTRIES) throw new Error("Allow list is full");
  const next = [...list, domain];
  await storage.set({ [ALLOW_LIST_STORAGE_KEY]: next });
  return next;
}

/** Removes one domain (normalized compare). Removing an absent one is a no-op. Returns the new list. */
export async function removeAllowedDomain(
  storage: AllowListStorage,
  input: string,
): Promise<string[]> {
  const domain = normalizeAllowedDomain(input);
  const list = await getAllowList(storage);
  if (domain === null || !list.includes(domain)) return list;
  const next = list.filter((entry) => entry !== domain);
  await storage.set({ [ALLOW_LIST_STORAGE_KEY]: next });
  return next;
}

/** Pure: true only when `domain` equals an entry exactly (case-insensitive). No subdomain matching. */
export function isDomainAllowed(list: readonly string[], domain: string): boolean {
  if (typeof domain !== "string") return false;
  return list.includes(domain.toLowerCase());
}

/** Gate: true only for a non-null page whose domain is on the stored list, read fresh on every call. Never throws; any failure is false. */
export function createAllowListGate(storage: AllowListStorage): CaptureGate {
  return {
    async allows(page) {
      try {
        if (page === null) return false;
        return isDomainAllowed(await getAllowList(storage), page.domain);
      } catch {
        return false;
      }
    },
  };
}
