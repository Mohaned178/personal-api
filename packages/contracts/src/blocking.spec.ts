import { describe, expect, it } from "vitest";
import {
  BLOCK_PATTERNS_MAX,
  FOCUS_MAX_MINUTES,
  focusSessionSchema,
  focusStartSchema,
  scheduleSaveSchema,
  scheduleSchema,
} from "./blocking.js";
import { ingestConfigResponseSchema } from "./ingest-config.js";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const schedule = {
  name: "Work hours",
  patterns: ["reddit.com", "*.youtube.com"],
  days: [0, 1, 2, 3, 4],
  start: "09:00",
  end: "17:00",
};
const manySites = Array.from({ length: BLOCK_PATTERNS_MAX + 1 }, (_, i) => `s${i}.com`);

describe("focusStartSchema", () => {
  it("takes sites and minutes", () => {
    expect(focusStartSchema.safeParse({ patterns: ["x.com"], minutes: 45 }).success).toBe(true);
    expect(
      focusStartSchema.safeParse({ patterns: ["x.com"], minutes: FOCUS_MAX_MINUTES }).success,
    ).toBe(true);
  });

  it.each([
    ["no sites", { patterns: [], minutes: 45 }],
    ["too many sites", { patterns: manySites, minutes: 45 }],
    ["a repeated site", { patterns: ["x.com", "x.com"], minutes: 45 }],
    ["a url", { patterns: ["https://x.com/a"], minutes: 45 }],
    ["zero minutes", { patterns: ["x.com"], minutes: 0 }],
    ["more than eight hours", { patterns: ["x.com"], minutes: FOCUS_MAX_MINUTES + 1 }],
    ["a fraction", { patterns: ["x.com"], minutes: 1.5 }],
    ["an end time", { patterns: ["x.com"], minutes: 5, endsAt: "2026-01-01T00:00:00Z" }],
    ["an owner", { patterns: ["x.com"], minutes: 5, userId: "u" }],
  ])("refuses %s", (_name, body) => {
    expect(focusStartSchema.safeParse(body).success).toBe(false);
  });
});

describe("focusSessionSchema", () => {
  it("needs an id and an ISO end time", () => {
    const ok = { id: ID, patterns: ["x.com"], endsAt: "2026-10-21T12:00:00.000Z" };
    expect(focusSessionSchema.safeParse(ok).success).toBe(true);
    expect(focusSessionSchema.safeParse({ ...ok, endsAt: "tomorrow" }).success).toBe(false);
    expect(focusSessionSchema.safeParse({ ...ok, id: "1" }).success).toBe(false);
  });
});

describe("scheduleSaveSchema", () => {
  it("is enabled unless said otherwise", () => {
    expect(scheduleSaveSchema.parse(schedule).enabled).toBe(true);
    expect(scheduleSaveSchema.parse({ ...schedule, enabled: false }).enabled).toBe(false);
  });

  it("accepts a block that crosses midnight", () => {
    const night = { ...schedule, start: "23:00", end: "07:00" };
    expect(scheduleSaveSchema.safeParse(night).success).toBe(true);
  });

  it.each([
    ["an empty name", { name: "  " }],
    ["a long name", { name: "x".repeat(61) }],
    ["no sites", { patterns: [] }],
    ["no days", { days: [] }],
    ["a day past Sunday", { days: [7] }],
    ["a repeated day", { days: [1, 1] }],
    ["a bad time", { start: "9:00" }],
    ["hour 24", { end: "24:00" }],
    ["equal times", { start: "09:00", end: "09:00" }],
    ["an id from the client", { id: ID }],
  ])("refuses %s", (_name, change) => {
    expect(scheduleSaveSchema.safeParse({ ...schedule, ...change }).success).toBe(false);
  });
});

describe("the config", () => {
  const base = { ruleSetVersion: 0, defaultPolicy: "deny", rules: [] };

  it("defaults to no focus session and no schedules", () => {
    const config = ingestConfigResponseSchema.parse(base);
    expect(config.focus).toBeNull();
    expect(config.schedules).toEqual([]);
  });

  it("carries a session and schedules", () => {
    const focus = { id: ID, patterns: ["x.com"], endsAt: "2026-10-21T12:00:00.000Z" };
    const config = ingestConfigResponseSchema.parse({
      ...base,
      focus,
      schedules: [{ id: ID, enabled: true, ...schedule }],
    });
    expect(config.focus).toEqual(focus);
    expect(scheduleSchema.safeParse(config.schedules[0]).success).toBe(true);
  });

  it("refuses a repeated schedule id", () => {
    const one = { id: ID, enabled: true, ...schedule };
    const config = { ...base, schedules: [one, one] };
    expect(ingestConfigResponseSchema.safeParse(config).success).toBe(false);
  });
});
