import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { RateLimiter } from "./rate-limiter";

const START = "2026-10-14T12:00:00.000Z";

function setup(options = { limit: 3, windowMs: 60_000 }, maxKeys = 10_000) {
  const clock = new FakeClock(START);
  return { clock, limiter: new RateLimiter({ ...options, maxKeys }, clock) };
}

describe("RateLimiter", () => {
  it("allows the limit, then refuses with the time left in the window", () => {
    const { clock, limiter } = setup();
    expect(limiter.consume("a").allowed).toBe(true);
    clock.advance(10_000);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    const refused = limiter.consume("a");
    expect(refused).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  it("keeps counting nothing against a refused caller (the window does not extend)", () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.consume("a");
    clock.advance(59_999);
    expect(limiter.consume("a")).toEqual({ allowed: false, retryAfterMs: 1 });
    clock.advance(1);
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("counts each key on its own", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.consume("a");
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("forgets everything on reset", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.consume("a");
    limiter.reset();
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("does not grow without bound, and still throttles the keys it keeps", () => {
    const { clock, limiter } = setup({ limit: 1, windowMs: 60_000 }, 3);
    for (const key of ["a", "b", "c", "d", "e"]) expect(limiter.consume(key).allowed).toBe(true);
    // a and b were evicted to make room; e (the newest) is still tracked.
    expect(limiter.consume("e").allowed).toBe(false);
    clock.advance(60_000);
    expect(limiter.consume("e").allowed).toBe(true);
  });
});
