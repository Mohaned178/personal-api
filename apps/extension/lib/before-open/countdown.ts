// M9-05 the pause page's countdown, pure so it is tested with a fixed clock.

/** Whole seconds still to wait, never below 0. */
export function secondsLeft(startedAt: number, now: number, seconds: number): number {
  return Math.max(0, Math.ceil((startedAt + seconds * 1000 - now) / 1000));
}
