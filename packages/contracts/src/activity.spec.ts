import { describe, expect, it } from "vitest";
import {
  activityDailyQuerySchema,
  activityDomainsQuerySchema,
  activityDomainsResponseSchema,
} from "./activity.js";
import { settingsSchema, timeZoneSchema, updateSettingsRequestSchema } from "./settings.js";

describe("activity queries", () => {
  it("accepts no range, and a range of up to 90 days", () => {
    expect(activityDailyQuerySchema.parse({})).toEqual({});
    expect(
      activityDailyQuerySchema.safeParse({
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-09-29T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty, reversed or too wide range", () => {
    const t = "2026-10-01T00:00:00.000Z";
    expect(activityDailyQuerySchema.safeParse({ from: t, to: t }).success).toBe(false);
    expect(
      activityDailyQuerySchema.safeParse({ from: t, to: "2026-09-01T00:00:00.000Z" }).success,
    ).toBe(false);
    expect(
      activityDailyQuerySchema.safeParse({ from: "2026-01-01T00:00:00.000Z", to: t }).success,
    ).toBe(false);
  });

  it("rejects unknown keys, including userId", () => {
    expect(activityDailyQuerySchema.safeParse({ userId: "x" }).success).toBe(false);
    expect(activityDomainsQuerySchema.safeParse({ tz: "UTC" }).success).toBe(false);
  });

  it("parses the domains limit from a string and bounds it", () => {
    expect(activityDomainsQuerySchema.parse({ limit: "5" })).toEqual({ limit: 5 });
    for (const limit of ["0", "101", "abc", "-1"]) {
      expect(activityDomainsQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it("response rows are strict", () => {
    const row = { domain: "github.com", activeMs: 1, pageVisits: 1 };
    const base = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
    expect(activityDomainsResponseSchema.safeParse({ ...base, domains: [row] }).success).toBe(true);
    expect(
      activityDomainsResponseSchema.safeParse({ ...base, domains: [{ ...row, path: "/" }] })
        .success,
    ).toBe(false);
  });
});

describe("time zone setting", () => {
  it("accepts IANA names and UTC", () => {
    for (const tz of ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Asia/Kolkata"]) {
      expect(timeZoneSchema.safeParse(tz).success, tz).toBe(true);
    }
  });

  it("refuses offsets, abbreviations, unknown names and SQL-shaped input", () => {
    for (const tz of [
      "+02:00",
      "GMT+2",
      "Mars/Olympus",
      "Europe/Berlin'; drop table events;--",
      "",
      " UTC",
      "x".repeat(65),
    ]) {
      expect(timeZoneSchema.safeParse(tz).success, tz).toBe(false);
    }
  });

  it("is strict", () => {
    expect(updateSettingsRequestSchema.safeParse({ timeZone: "UTC", userId: "x" }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({}).success).toBe(false);
  });
});
