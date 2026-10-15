import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { AppException } from "../../platform/errors/problem";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import {
  PAIR_ATTEMPTS_PER_WINDOW,
  PAIR_WINDOW_MS,
  PairRateLimitGuard,
} from "./pair-rate-limit.guard";

function setup() {
  const clock = new FakeClock("2026-10-14T12:00:00.000Z");
  const guard = new PairRateLimitGuard(
    new RateLimiter({ limit: PAIR_ATTEMPTS_PER_WINDOW, windowMs: PAIR_WINDOW_MS }, clock),
  );
  const headers: Record<string, string> = {};
  const context = (req: { ip?: string; headers?: Record<string, string> }) =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            headers[name] = value;
          },
        }),
      }),
    }) as unknown as ExecutionContext;
  return { clock, guard, headers, context };
}

describe("PairRateLimitGuard", () => {
  it("lets 10 attempts through per address, then answers 429 pairing.rate_limited with Retry-After", () => {
    const { clock, guard, headers, context } = setup();
    for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) {
      expect(guard.canActivate(context({ ip: "203.0.113.7" }))).toBe(true);
    }
    clock.advance(1_500);
    let thrown: unknown;
    try {
      guard.canActivate(context({ ip: "203.0.113.7" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect(thrown).toMatchObject({ code: "pairing.rate_limited" });
    expect((thrown as AppException).getStatus()).toBe(429);
    expect(headers["Retry-After"]).toBe("59");
  });

  it("keys on req.ip only: a forged X-Forwarded-For neither shares nor resets a bucket", () => {
    const { guard, context } = setup();
    for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) {
      guard.canActivate(
        context({ ip: "203.0.113.7", headers: { "x-forwarded-for": `10.0.0.${i}` } }),
      );
    }
    expect(() =>
      guard.canActivate(
        context({ ip: "203.0.113.7", headers: { "x-forwarded-for": "198.51.100.1" } }),
      ),
    ).toThrow(AppException);
    expect(guard.canActivate(context({ ip: "203.0.113.8" }))).toBe(true);
  });

  it("puts a request with no address in one shared bucket instead of skipping the limit", () => {
    const { guard, context } = setup();
    for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) guard.canActivate(context({}));
    expect(() => guard.canActivate(context({}))).toThrow(AppException);
  });

  it("lets the address back in when the window has passed", () => {
    const { clock, guard, context } = setup();
    for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) guard.canActivate(context({ ip: "a" }));
    expect(() => guard.canActivate(context({ ip: "a" }))).toThrow(AppException);
    clock.advance(PAIR_WINDOW_MS);
    expect(guard.canActivate(context({ ip: "a" }))).toBe(true);
  });
});
