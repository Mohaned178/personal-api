import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { AppException } from "../../platform/errors/problem";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import {
  INGEST_REQUESTS_PER_WINDOW,
  INGEST_WINDOW_MS,
  IngestRateLimitGuard,
} from "./ingest-rate-limit.guard";

function setup() {
  const clock = new FakeClock("2026-10-14T12:00:00.000Z");
  const guard = new IngestRateLimitGuard(
    new RateLimiter({ limit: INGEST_REQUESTS_PER_WINDOW, windowMs: INGEST_WINDOW_MS }, clock),
  );
  const headers: Record<string, string> = {};
  const context = (auth: unknown) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ auth }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            headers[name] = value;
          },
        }),
      }),
    }) as unknown as ExecutionContext;
  return { clock, guard, headers, context };
}

const key = (keyId: string) => ({ kind: "ingest", keyId, userId: "u", integrationId: "i" });

describe("IngestRateLimitGuard", () => {
  it("lets the limit through per key, then answers 429 ingest.rate_limited with Retry-After", () => {
    const { clock, guard, headers, context } = setup();
    for (let i = 0; i < INGEST_REQUESTS_PER_WINDOW; i++) {
      expect(guard.canActivate(context(key("k1")))).toBe(true);
    }
    clock.advance(2_000);
    let thrown: unknown;
    try {
      guard.canActivate(context(key("k1")));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect(thrown).toMatchObject({ code: "ingest.rate_limited" });
    expect((thrown as AppException).getStatus()).toBe(429);
    expect(headers["Retry-After"]).toBe("58");
  });

  it("counts each key on its own and starts a new window after the old one ends", () => {
    const { clock, guard, context } = setup();
    for (let i = 0; i < INGEST_REQUESTS_PER_WINDOW; i++) guard.canActivate(context(key("k1")));
    expect(() => guard.canActivate(context(key("k1")))).toThrow(AppException);
    expect(guard.canActivate(context(key("k2")))).toBe(true);
    clock.advance(INGEST_WINDOW_MS);
    expect(guard.canActivate(context(key("k1")))).toBe(true);
  });

  it("fails closed with 401 when no ingest key was authenticated before it", () => {
    const { guard, context } = setup();
    for (const auth of [undefined, { kind: "session", userId: "u" }]) {
      expect(() => guard.canActivate(context(auth))).toThrowError(
        expect.objectContaining({ code: "auth.invalid_key" }),
      );
    }
  });
});
