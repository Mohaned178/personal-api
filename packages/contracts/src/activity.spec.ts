import { describe, expect, it } from "vitest";
import {
  activityDailyQuerySchema,
  activityDomainsQuerySchema,
  activityDomainsResponseSchema,
  activityHoursQuerySchema,
  activitySessionsQuerySchema,
  activitySiteQuerySchema,
  activitySiteResponseSchema,
} from "./activity.js";
import {
  settingsSchema,
  TIME_ZONE_UNSUPPORTED_CODE,
  timeZoneSchema,
  timeZonesResponseSchema,
  updateSettingsRequestSchema,
} from "./settings.js";

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

  it("leaves the range check to the server, which has one code for it and fills in a missing end", () => {
    // The pair is checked by ActivityService (activity.range_invalid), so a bad pair is never a
    // different error depending on whether an end was defaulted.
    const t = "2026-10-01T00:00:00.000Z";
    expect(activityDailyQuerySchema.safeParse({ from: t, to: t }).success).toBe(true);
    expect(
      activityDailyQuerySchema.safeParse({ from: t, to: "2026-09-01T00:00:00.000Z" }).success,
    ).toBe(true);
    expect(
      activityDomainsQuerySchema.safeParse({ from: "2026-01-01T00:00:00.000Z", to: t }).success,
    ).toBe(true);
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

  it("lists time zones, each of which the PATCH accepts", () => {
    expect(TIME_ZONE_UNSUPPORTED_CODE).toBe("settings.time_zone_unsupported");
    expect(timeZonesResponseSchema.parse({ timeZones: ["Europe/Berlin", "UTC"] })).toEqual({
      timeZones: ["Europe/Berlin", "UTC"],
    });
    expect(timeZonesResponseSchema.safeParse({ timeZones: ["+02:00"] }).success).toBe(false);
    expect(timeZonesResponseSchema.safeParse({ timeZones: [], extra: 1 }).success).toBe(false);
  });

  it("is strict", () => {
    expect(updateSettingsRequestSchema.safeParse({ timeZone: "UTC", userId: "x" }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({}).success).toBe(false);
  });
});

describe("detailed dashboard queries (M9-03)", () => {
  it("needs a lowercase hostname for a site and refuses unknown keys", () => {
    expect(activitySiteQuerySchema.safeParse({ domain: "example.com" }).success).toBe(true);
    expect(activitySiteQuerySchema.safeParse({}).success).toBe(false);
    expect(activitySiteQuerySchema.safeParse({ domain: "Example.com" }).success).toBe(false);
    expect(activitySiteQuerySchema.safeParse({ domain: "a.test", userId: "x" }).success).toBe(
      false,
    );
  });

  it("takes only a range for the hours", () => {
    expect(activityHoursQuerySchema.safeParse({}).success).toBe(true);
    expect(activityHoursQuerySchema.safeParse({ tz: "UTC" }).success).toBe(false);
  });

  it("turns the sessions limit into a number between 1 and 200", () => {
    expect(activitySessionsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    for (const limit of ["0", "201", "-1", "x", "1.5"]) {
      expect(activitySessionsQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(activitySessionsQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("describes a site response with at most 10 paths", () => {
    const base = {
      domain: "a.test",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
      timeZone: "UTC",
      days: [],
      activeMs: 0,
      pageVisits: 0,
      sessions: 0,
      averageSessionMs: 0,
      longestSessionMs: 0,
    };
    const path = { path: "/", activeMs: 1, pageVisits: 1 };
    expect(activitySiteResponseSchema.safeParse({ ...base, paths: [path] }).success).toBe(true);
    expect(
      activitySiteResponseSchema.safeParse({ ...base, paths: Array(11).fill(path) }).success,
    ).toBe(false);
  });
});
