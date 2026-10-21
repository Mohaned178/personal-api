import { describe, expect, it } from "vitest";
import { recommendationKey, recommendationSchema } from "./recommendations.js";

describe("recommendations", () => {
  it("accepts each kind and refuses an unknown one or an extra field", () => {
    expect(
      recommendationSchema.safeParse({
        kind: "limit_plan",
        domain: "youtube.com",
        averageMinutes: 95,
        steps: [90, 75, 60],
      }).success,
    ).toBe(true);
    expect(
      recommendationSchema.safeParse({
        kind: "late_night",
        domain: "youtube.com",
        sharePercent: 60,
        fromHour: 23,
        toHour: 7,
      }).success,
    ).toBe(true);
    expect(recommendationSchema.safeParse({ kind: "other" }).success).toBe(false);
    expect(
      recommendationSchema.safeParse({
        kind: "late_night",
        domain: "youtube.com",
        sharePercent: 60,
        fromHour: 23,
        toHour: 7,
        userId: "x",
      }).success,
    ).toBe(false);
  });

  it("needs at least two steps in a plan", () => {
    expect(
      recommendationSchema.safeParse({
        kind: "limit_plan",
        domain: "youtube.com",
        averageMinutes: 95,
        steps: [90],
      }).success,
    ).toBe(false);
  });

  it("keys a step by its target so the next step is not hidden by a dismissed one", () => {
    const step = {
      kind: "limit_step" as const,
      limitId: "0197a1b2-0000-7000-8000-000000000001",
      pattern: "youtube.com",
      strict: false,
      currentMinutes: 75,
      nextMinutes: 60,
    };
    expect(recommendationKey(step)).not.toBe(recommendationKey({ ...step, nextMinutes: 45 }));
  });
});
