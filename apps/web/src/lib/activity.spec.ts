import { describe, expect, it } from "vitest";
import { formatDuration, insightsWindow } from "./activity";

// M8-03: the Insights window is the last 7 local days in the user's saved time zone, so the
// server (which cuts days in that zone) and the page agree on what "today" is.

describe("insightsWindow", () => {
  it("cuts days in the user's zone, not UTC", () => {
    // 03:00 UTC on the 21st is still the evening of the 20th in Los Angeles (UTC-7).
    const w = insightsWindow(new Date("2026-10-21T03:00:00.000Z"), "America/Los_Angeles");
    expect(w.today).toBe("2026-10-20");
    expect(w.dates).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(w.from).toBe("2026-10-14T07:00:00.000Z");
    expect(w.to).toBe("2026-10-21T03:00:00.000Z");
  });

  it("finds local midnight across a DST change", () => {
    // Berlin leaves summer time on 2026-10-25: the window starts at 00:00 CEST (UTC+2).
    const w = insightsWindow(new Date("2026-10-27T12:00:00.000Z"), "Europe/Berlin");
    expect(w.today).toBe("2026-10-27");
    expect(w.from).toBe("2026-10-20T22:00:00.000Z");
  });

  it("crosses a month boundary", () => {
    const w = insightsWindow(new Date("2026-11-02T12:00:00.000Z"), "UTC");
    expect(w.dates[0]).toBe("2026-10-27");
    expect(w.from).toBe("2026-10-27T00:00:00.000Z");
  });

  it("throws for a zone the browser does not know", () => {
    expect(() => insightsWindow(new Date(), "Not/AZone")).toThrow(RangeError);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [59_000, "< 1m"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [125 * 60_000, "2h 05m"],
  ])("%i ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
