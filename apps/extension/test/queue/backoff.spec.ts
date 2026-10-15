// M2-05 backoff: exponential with a cap, jitter that only ever adds, and never below the 30 s an
// alarm can honour. Pure function: the clock and the random source are not involved.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_JITTER_RATIO,
  backoffDelayMs,
} from "../../lib/queue";

const rawDelay = (failures: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

describe("backoffDelayMs", () => {
  it("pins the numbers: 30 s base, doubling, 15 min cap, up to +25 % jitter", () => {
    expect(BACKOFF_BASE_MS).toBe(30_000);
    expect(BACKOFF_CAP_MS).toBe(900_000);
    expect(BACKOFF_JITTER_RATIO).toBe(0.25);
  });

  it("doubles per consecutive failure and stops at the cap (random = 0)", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 30].map((n) => backoffDelayMs(n, () => 0));
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000,
    ]);
  });

  it("adds jitter on top, between 0 and 25 %, never below the raw delay", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(30_000);
    expect(backoffDelayMs(1, () => 0.5)).toBe(33_750);
    expect(backoffDelayMs(1, () => 0.999999)).toBe(37_499);
    expect(backoffDelayMs(3, () => 0.5)).toBe(135_000);
    expect(backoffDelayMs(9, () => 0.5)).toBe(1_012_500); // jitter applies at the cap too
  });

  it("never returns less than 30 s, whatever the failure count and random value", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (n, r) => {
        const delay = backoffDelayMs(n, () => r);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
        expect(delay).toBeGreaterThanOrEqual(rawDelay(n));
        expect(delay).toBeLessThan(rawDelay(n) * (1 + BACKOFF_JITTER_RATIO) + 1);
      }),
    );
  });

  it("never gets shorter as failures pile up (same random value)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (n, r) => {
        expect(backoffDelayMs(n + 1, () => r)).toBeGreaterThanOrEqual(backoffDelayMs(n, () => r));
      }),
    );
  });

  it("asks the random source exactly once", () => {
    let calls = 0;
    backoffDelayMs(4, () => {
      calls++;
      return 0.1;
    });
    expect(calls).toBe(1);
  });
});
