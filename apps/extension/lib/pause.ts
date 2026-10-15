// M2-06 pause/resume. STUB: the implementer replaces the bodies (the tests define the behavior).

/** `browser.storage.local` key that holds the pause flag (a boolean). */
export const PAUSED_STORAGE_KEY = "paused";

/**
 * True when capture is paused. Absent key = not paused. Fails closed (invariant 1): a stored value
 * that is not exactly `false` (for example garbage), or a storage read that throws, counts as paused.
 */
export function getPaused(_storage: {
  get(key: string): Promise<Record<string, unknown>>;
}): Promise<boolean> {
  return Promise.reject(new Error("not implemented"));
}

/** Persists the flag under `PAUSED_STORAGE_KEY` (survives a background kill). */
export function setPaused(
  _storage: { set(items: Record<string, unknown>): Promise<void> },
  _paused: boolean,
): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}
