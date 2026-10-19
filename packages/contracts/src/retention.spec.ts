import { describe, expect, it } from "vitest";
import {
  putRetentionRequestSchema,
  RETENTION_DEFAULT_DAYS,
  RETENTION_MAX_DAYS,
  resolveRetentionDays,
  retentionTargetSchema,
} from "./retention.js";

describe("resolveRetentionDays", () => {
  it("prefers rule over type over source over the default", () => {
    expect(resolveRetentionDays({ rule: 1, type: 2, source: 3 })).toBe(1);
    expect(resolveRetentionDays({ rule: null, type: 2, source: 3 })).toBe(2);
    expect(resolveRetentionDays({ rule: null, type: null, source: 3 })).toBe(3);
    expect(resolveRetentionDays({ rule: null, type: null, source: null })).toBe(
      RETENTION_DEFAULT_DAYS,
    );
  });
});

describe("retention requests", () => {
  it("accepts 1..max whole days and nothing else", () => {
    for (const days of [1, 30, RETENTION_MAX_DAYS]) {
      expect(putRetentionRequestSchema.safeParse({ days }).success).toBe(true);
    }
    for (const days of [0, -1, 1.5, RETENTION_MAX_DAYS + 1, "7", null]) {
      expect(putRetentionRequestSchema.safeParse({ days }).success).toBe(false);
    }
  });

  it("rejects unknown keys (userId never comes from the body)", () => {
    expect(putRetentionRequestSchema.safeParse({ days: 5, userId: "x" }).success).toBe(false);
  });

  it("checks targets by scope", () => {
    expect(retentionTargetSchema("type").safeParse("browser.page_visited").success).toBe(true);
    expect(retentionTargetSchema("type").safeParse("nope.type").success).toBe(false);
    expect(retentionTargetSchema("source").safeParse("not-a-uuid").success).toBe(false);
    expect(retentionTargetSchema("source").parse("0192F1C2-7C1E-7A3B-9F00-1C2D3E4F5A6B")).toBe(
      "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
    );
  });
});
