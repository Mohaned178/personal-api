import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_JITTER_RATIO } from "./constants";

/**
 * Delay before the next attempt after `failures` consecutive failures (1-based):
 * `raw = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))`, then
 * `raw + floor(random() * BACKOFF_JITTER_RATIO * raw)`. Pure. Jitter only ever adds, so the delay
 * is never below the 30 s an alarm can honour. Asks `random` exactly once.
 */
export function backoffDelayMs(failures: number, random: () => number): number {
  const exponent = Number.isFinite(failures) && failures > 1 ? Math.floor(failures) - 1 : 0;
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const r = random();
  const unit = Number.isFinite(r) && r > 0 ? Math.min(r, 1 - Number.EPSILON) : 0;
  return raw + Math.floor(unit * BACKOFF_JITTER_RATIO * raw);
}
