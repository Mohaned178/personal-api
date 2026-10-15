/**
 * Delay before the next attempt after `failures` consecutive failures (1-based):
 * `raw = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))`, then
 * `raw + floor(random() * BACKOFF_JITTER_RATIO * raw)`. Pure. Not implemented.
 */
export function backoffDelayMs(_failures: number, _random: () => number): number {
  throw new Error("not implemented");
}
