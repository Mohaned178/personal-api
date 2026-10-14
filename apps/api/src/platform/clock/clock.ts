/**
 * M1-03 (test-writer stub): the time source. Anything time-based takes a `Clock` so tests can
 * fix it (CLAUDE.md: fixed clocks). The builder provides `CLOCK` globally with `systemClock`;
 * tests override `CLOCK` with `apps/api/test/fake-clock.ts`.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = { now: () => new Date() };
