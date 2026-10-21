import { describe, expect, it } from "vitest";
import { daysWindow } from "./activity";

// M9-03: windows of any length, ending today or some days back, still cut at local midnight.

describe("daysWindow", () => {
  it("ends an earlier window at the next local midnight", () => {
    // 03:00 UTC on the 21st is the evening of the 20th in Los Angeles (UTC-7).
    const last = daysWindow(new Date("2026-10-21T03:00:00.000Z"), "America/Los_Angeles", 7, 7);
    expect(last.dates[0]).toBe("2026-10-07");
    expect(last.today).toBe("2026-10-13");
    expect(last.from).toBe("2026-10-07T07:00:00.000Z");
    expect(last.to).toBe("2026-10-14T07:00:00.000Z");
  });

  it("measures yesterday across a 25-hour day (New York leaves summer time on 2026-11-01)", () => {
    const w = daysWindow(new Date("2026-11-02T12:00:00.000Z"), "America/New_York", 1, 1);
    expect(w.dates).toEqual(["2026-11-01"]);
    expect(w.from).toBe("2026-11-01T04:00:00.000Z");
    expect(w.to).toBe("2026-11-02T05:00:00.000Z");
  });

  it("makes 28 and 30 day windows that end now", () => {
    const now = new Date("2026-10-21T03:00:00.000Z");
    expect(daysWindow(now, "UTC", 28).dates).toHaveLength(28);
    const w = daysWindow(now, "UTC", 30);
    expect(w.dates[0]).toBe("2026-09-22");
    expect(w.to).toBe(now.toISOString());
  });
});
