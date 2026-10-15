// M2-06 pause/resume: the flag the capture gate consults first (lib/queue/wire.ts).

/** `browser.storage.local` key that holds the pause flag (a boolean). */
export const PAUSED_STORAGE_KEY = "paused";

/**
 * True when capture is paused. An absent key (or an `undefined` value) = not paused. Fails closed
 * (invariant 1): a stored value that is not exactly `false` (for example garbage), or a storage
 * read that throws, counts as paused.
 */
export async function getPaused(storage: {
  get(key: string): Promise<Record<string, unknown>>;
}): Promise<boolean> {
  try {
    const stored = await storage.get(PAUSED_STORAGE_KEY);
    const value = stored[PAUSED_STORAGE_KEY];
    if (value === undefined) return false;
    return value !== false;
  } catch {
    return true;
  }
}

/** Persists the flag under `PAUSED_STORAGE_KEY` (survives a background kill). */
export function setPaused(
  storage: { set(items: Record<string, unknown>): Promise<void> },
  paused: boolean,
): Promise<void> {
  return storage.set({ [PAUSED_STORAGE_KEY]: paused });
}
