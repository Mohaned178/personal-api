import { describe, expect, it } from "vitest";
import { ingestConfigResponseSchema } from "./ingest-config.js";
import {
  LIMIT_MAX_MINUTES,
  LIMITS_PER_USER_MAX,
  limitListResponseSchema,
  limitSaveSchema,
  limitSchema,
} from "./limits.js";

const LIMIT_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const OTHER_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c";
const limit = { id: LIMIT_ID, pattern: "youtube.com", minutes: 60, strict: false };

describe("limitSaveSchema", () => {
  it("accepts a domain, a wildcard domain and a number of minutes", () => {
    expect(limitSaveSchema.safeParse({ pattern: "youtube.com", minutes: 30 }).success).toBe(true);
    expect(limitSaveSchema.safeParse({ pattern: "*.reddit.com", minutes: 1 }).success).toBe(true);
    expect(
      limitSaveSchema.safeParse({ pattern: "x.com", minutes: LIMIT_MAX_MINUTES }).success,
    ).toBe(true);
  });

  it("is not strict mode unless asked", () => {
    expect(limitSaveSchema.parse({ pattern: "youtube.com", minutes: 30 }).strict).toBe(false);
    expect(
      limitSaveSchema.parse({ pattern: "youtube.com", minutes: 30, strict: true }).strict,
    ).toBe(true);
  });

  it.each([
    ["a missing pattern", { minutes: 30 }],
    ["a missing number of minutes", { pattern: "youtube.com" }],
    ["zero minutes", { pattern: "youtube.com", minutes: 0 }],
    ["a negative number", { pattern: "youtube.com", minutes: -5 }],
    ["more than a day", { pattern: "youtube.com", minutes: LIMIT_MAX_MINUTES + 1 }],
    ["a fraction", { pattern: "youtube.com", minutes: 1.5 }],
    ["minutes as text", { pattern: "youtube.com", minutes: "30" }],
    ["a url instead of a domain", { pattern: "https://youtube.com/watch", minutes: 30 }],
    ["a path", { pattern: "youtube.com/watch", minutes: 30 }],
    ["an uppercase domain", { pattern: "YouTube.com", minutes: 30 }],
    ["a bare star", { pattern: "*", minutes: 30 }],
    ["a star in the middle", { pattern: "you*tube.com", minutes: 30 }],
    ["an empty pattern", { pattern: "", minutes: 30 }],
    ["an id in the body", { id: LIMIT_ID, pattern: "youtube.com", minutes: 30 }],
    ["a user id in the body", { userId: "u1", pattern: "youtube.com", minutes: 30 }],
    ["strict as text", { pattern: "youtube.com", minutes: 30, strict: "yes" }],
  ])("rejects %s", (_label, body) => {
    expect(limitSaveSchema.safeParse(body).success).toBe(false);
  });

  it("never echoes the rejected pattern in an issue message", () => {
    const result = limitSaveSchema.safeParse({ pattern: "secret-site.example/path", minutes: 30 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("secret-site");
  });
});

describe("limitSchema and limitListResponseSchema", () => {
  it("is a saved limit plus the server's id", () => {
    expect(limitSchema.safeParse(limit).success).toBe(true);
    expect(limitSchema.safeParse({ ...limit, id: "not-a-uuid" }).success).toBe(false);
    expect(limitSchema.safeParse({ ...limit, userId: "u1" }).success).toBe(false);
  });

  it("lists limits", () => {
    expect(limitListResponseSchema.safeParse({ limits: [limit] }).success).toBe(true);
    expect(limitListResponseSchema.safeParse({ limits: [] }).success).toBe(true);
    expect(limitListResponseSchema.safeParse({ limits: [], extra: 1 }).success).toBe(false);
  });
});

describe("limits in the extension config", () => {
  const base = { ruleSetVersion: 1, defaultPolicy: "deny", rules: [] };

  it("defaults to no limits, so a config stored before M9-02 is still valid", () => {
    const parsed = ingestConfigResponseSchema.parse(base);
    expect(parsed.limits).toEqual([]);
  });

  it("carries the user's limits", () => {
    const parsed = ingestConfigResponseSchema.parse({ ...base, limits: [limit] });
    expect(parsed.limits).toEqual([limit]);
  });

  it.each([
    ["a duplicate id", [limit, { ...limit, pattern: "reddit.com" }]],
    ["a duplicate pattern", [limit, { ...limit, id: OTHER_ID }]],
    ["an invalid limit", [{ ...limit, minutes: 0 }]],
    ["an unknown key", [{ ...limit, userId: "u1" }]],
  ])("rejects %s", (_label, limits) => {
    expect(ingestConfigResponseSchema.safeParse({ ...base, limits }).success).toBe(false);
  });

  it("rejects more limits than a user may have", () => {
    const many = Array.from({ length: LIMITS_PER_USER_MAX + 1 }, (_, index) => ({
      id: `0192f1c2-7c1e-7a3b-9f00-${String(index).padStart(12, "0")}`,
      pattern: `site${index}.example.com`,
      minutes: 10,
      strict: false,
    }));
    expect(ingestConfigResponseSchema.safeParse({ ...base, limits: many }).success).toBe(false);
  });
});
