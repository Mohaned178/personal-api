/**
 * The time source. Anything time-based takes a `Clock` (injected as `CLOCK`) so tests can fix it
 * (CLAUDE.md: fixed clocks). `ClockModule` provides `systemClock` globally; tests override `CLOCK`
 * with `apps/api/test/fake-clock.ts`.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = { now: () => new Date() };
