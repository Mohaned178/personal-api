import type { Limit } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { type DomainDay, recommend } from "./recommendations.rules";

const MIN = 60_000;
const ID = "0197a1b2-0000-7000-8000-000000000001";

/** `count` consecutive local dates ending 2026-10-14. */
function dates(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 14 - (count - 1 - i)));
    return d.toISOString().slice(0, 10);
  });
}

function usage(domain: string, count: number, minutes: number, nightMinutes = 0): DomainDay[] {
  return dates(count).map((date) => ({
    domain,
    date,
    activeMs: minutes * MIN,
    nightMs: nightMinutes * MIN,
  }));
}

const base = { limits: [] as Limit[], dataSpanDays: 28, recentFrom: "2026-10-08" };
const limit = (pattern: string, minutes: number, strict = false): Limit => ({
  id: ID,
  pattern,
  minutes,
  strict,
});

describe("recommend: not enough data", () => {
  it("suggests nothing before two weeks of data", () => {
    expect(recommend({ ...base, dataSpanDays: 13, days: usage("youtube.com", 13, 100) })).toEqual(
      [],
    );
  });

  it("suggests nothing for a site used on fewer than 10 days", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 9, 100) })).toEqual([]);
  });

  it("suggests nothing for a light site", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 28, 40) })).toEqual([]);
  });

  it("suggests nothing for no activity", () => {
    expect(recommend({ ...base, days: [] })).toEqual([]);
  });
});

describe("recommend: stepped limit plan", () => {
  it("steps a heavy site from its average down a third, 15 minutes at a time", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 20, 95) })).toEqual([
      { kind: "limit_plan", domain: "youtube.com", averageMinutes: 95, steps: [90, 75, 60] },
    ]);
  });

  it("stops at 30 minutes", () => {
    const [plan] = recommend({ ...base, days: usage("youtube.com", 20, 50) });
    expect(plan).toMatchObject({ steps: [45, 30] });
  });

  it("keeps at most four steps", () => {
    const [plan] = recommend({ ...base, days: usage("youtube.com", 20, 300) });
    expect(plan).toMatchObject({ kind: "limit_plan", steps: [300, 285, 270, 255] });
  });

  it("averages over the days the site was used, not over the window", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 10, 100) })).toHaveLength(1);
  });

  it("does not plan for a site an exact or wildcard limit already covers", () => {
    const days = [...usage("youtube.com", 20, 95), ...usage("m.reddit.com", 20, 95)];
    const out = recommend({
      ...base,
      days,
      limits: [limit("youtube.com", 120), limit("*.reddit.com", 120)],
    });
    expect(out.filter((r) => r.kind === "limit_plan")).toEqual([]);
  });

  it("puts the heaviest site first, ties by name", () => {
    const days = [...usage("b.com", 20, 60), ...usage("a.com", 20, 60), ...usage("c.com", 20, 120)];
    const domains = recommend({ ...base, days }).map((r) => (r as { domain: string }).domain);
    expect(domains).toEqual(["c.com", "a.com", "b.com"]);
  });
});

describe("recommend: step down an existing limit", () => {
  it("lowers a limit that was kept for the last week by 15 minutes", () => {
    const days = usage("youtube.com", 28, 50);
    expect(recommend({ ...base, days, limits: [limit("youtube.com", 60, true)] })).toEqual([
      {
        kind: "limit_step",
        limitId: ID,
        pattern: "youtube.com",
        strict: true,
        currentMinutes: 60,
        nextMinutes: 45,
      },
    ]);
  });

  it("waits while a day of the last week went over the limit", () => {
    const days = usage("youtube.com", 28, 50);
    days[days.length - 2] = { ...(days[days.length - 2] as DomainDay), activeMs: 70 * MIN };
    expect(recommend({ ...base, days, limits: [limit("youtube.com", 60)] })).toEqual([]);
  });

  it("waits with fewer than 5 active days in the last week", () => {
    // 28 days of data, but only the last 4 days are in the last week
    const days = usage("youtube.com", 28, 50).filter(
      (d) => d.date < "2026-10-08" || d.date > "2026-10-10",
    );
    expect(recommend({ ...base, days, limits: [limit("youtube.com", 60)] })).toEqual([]);
  });

  it("sums every site a wildcard covers", () => {
    const days = [...usage("a.reddit.com", 28, 40), ...usage("b.reddit.com", 28, 40)];
    expect(recommend({ ...base, days, limits: [limit("*.reddit.com", 90)] })).toEqual([
      expect.objectContaining({ kind: "limit_step", pattern: "*.reddit.com", nextMinutes: 75 }),
    ]);
    expect(recommend({ ...base, days, limits: [limit("*.reddit.com", 60)] })).toEqual([]);
  });

  it("never goes under 30 minutes", () => {
    const days = usage("youtube.com", 28, 20);
    expect(recommend({ ...base, days, limits: [limit("youtube.com", 40)] })).toEqual([]);
  });

  it("ignores days before the last week", () => {
    const days = usage("youtube.com", 28, 50);
    days[0] = { ...(days[0] as DomainDay), activeMs: 300 * MIN };
    expect(recommend({ ...base, days, limits: [limit("youtube.com", 60)] })).toHaveLength(1);
  });
});

describe("recommend: late-night hint", () => {
  it("flags a site whose time is mostly between 23:00 and 07:00", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 10, 40, 30) })).toEqual([
      { kind: "late_night", domain: "youtube.com", sharePercent: 75, fromHour: 23, toHour: 7 },
    ]);
  });

  it("needs most of the time at night", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 10, 40, 10) })).toEqual([]);
  });

  it("needs at least 3 hours at night, over at least 4 days", () => {
    expect(recommend({ ...base, days: usage("youtube.com", 10, 10, 8) })).toEqual([]);
    expect(recommend({ ...base, days: usage("youtube.com", 3, 90, 80) })).toEqual([]);
  });
});

describe("recommend: order and size", () => {
  it("lists steps down, then plans, then late-night hints, at most 6", () => {
    const days = [
      ...usage("kept.com", 28, 50),
      ...usage("heavy.com", 20, 95),
      ...usage("night.com", 10, 40, 30),
      ...Array.from({ length: 6 }, (_, i) => usage(`many${i}.com`, 20, 60)).flat(),
    ];
    const out = recommend({ ...base, days, limits: [limit("kept.com", 60)] });
    expect(out).toHaveLength(6);
    expect(out[0]?.kind).toBe("limit_step");
    expect(out[1]?.kind).toBe("limit_plan");
  });

  it("gives the same answer for the same input", () => {
    const days = [...usage("heavy.com", 20, 95), ...usage("night.com", 10, 40, 30)];
    expect(recommend({ ...base, days })).toEqual(recommend({ ...base, days }));
  });
});
