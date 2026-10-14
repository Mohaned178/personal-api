import type { Clock } from "../src/platform/clock/clock";

/** A controllable clock for tests (CLAUDE.md: fixed clocks for anything time-based). */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string = "2026-10-14T12:00:00.000Z") {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date | string): void {
    this.current = new Date(date);
  }
}
