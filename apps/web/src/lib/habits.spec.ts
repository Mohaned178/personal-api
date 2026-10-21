import type { CategoryDay, Limit } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { goalProgress, limitDays, summarize, topChanges, totalsOf } from "./habits";

const MIN = 60_000;
const day = (date: string, distracting: number, productive = 0, neutral = 0): CategoryDay => ({
  date,
  productiveMs: productive * MIN,
  neutralMs: neutral * MIN,
  distractingMs: distracting * MIN,
});
/** Consecutive dates ending 2026-10-21, with distracting minutes given oldest first. */
const run = (minutes: number[]): CategoryDay[] =>
  minutes.map((m, i) => {
    const date = new Date(Date.UTC(2026, 9, 21 - (minutes.length - 1 - i)));
    return day(date.toISOString().slice(0, 10), m, m === 0 ? 0 : 5);
  });

describe("totalsOf", () => {
  it("adds each category and the total", () => {
    expect(totalsOf([day("2026-10-20", 10, 20, 30), day("2026-10-21", 1, 2, 3)])).toEqual({
      productiveMs: 22 * MIN,
      neutralMs: 33 * MIN,
      distractingMs: 11 * MIN,
      totalMs: 66 * MIN,
    });
    expect(totalsOf([]).totalMs).toBe(0);
  });
});

describe("goalProgress (stay under 60 minutes of distracting sites)", () => {
  it("counts consecutive days at or under the goal, ending today", () => {
    expect(goalProgress(run([90, 40, 60, 10]), "distracting", 60)).toMatchObject({
      streak: 3,
      todayMs: 10 * MIN,
    });
  });

  it("is 0 when today is over the goal", () => {
    expect(goalProgress(run([10, 10, 61]), "distracting", 60).streak).toBe(0);
  });

  it("stops at the last day over the goal, whatever came before", () => {
    expect(goalProgress(run([10, 10, 100, 20, 30]), "distracting", 60).streak).toBe(2);
  });

  it("does not count days before the first day with activity", () => {
    const days = [
      day("2026-10-18", 0),
      day("2026-10-19", 0),
      day("2026-10-20", 5),
      day("2026-10-21", 0, 5),
    ];
    expect(goalProgress(days, "distracting", 60).streak).toBe(2);
  });

  it("counts a quiet day in the middle as a kept day", () => {
    const days = [day("2026-10-19", 5), day("2026-10-20", 0), day("2026-10-21", 0, 5)];
    expect(goalProgress(days, "distracting", 60).streak).toBe(3);
  });

  it("is 0 without any activity", () => {
    expect(goalProgress([day("2026-10-20", 0), day("2026-10-21", 0)], "distracting", 60)).toEqual({
      todayMs: 0,
      streak: 0,
      capped: false,
    });
  });

  it("says when the streak fills the whole window", () => {
    const progress = goalProgress(run([10, 20, 30]), "distracting", 60);
    expect(progress).toMatchObject({ streak: 3, capped: true });
    expect(goalProgress(run([100, 20, 30]), "distracting", 60).capped).toBe(false);
  });

  it("judges the neutral goal on neutral time", () => {
    const days = [day("2026-10-20", 0, 0, 90), day("2026-10-21", 500, 0, 10)];
    expect(goalProgress(days, "neutral", 60).streak).toBe(1);
  });
});

describe("topChanges", () => {
  it("ranks sites by how far they moved, either way, and drops unchanged ones", () => {
    const rows = [
      { domain: "a.com", thisWeekMs: 10 * MIN, lastWeekMs: 10 * MIN },
      { domain: "b.com", thisWeekMs: 60 * MIN, lastWeekMs: 10 * MIN },
      { domain: "c.com", thisWeekMs: 0, lastWeekMs: 90 * MIN },
      { domain: "d.com", thisWeekMs: 20 * MIN, lastWeekMs: 5 * MIN },
    ];
    expect(topChanges(rows, 2).map((r) => [r.domain, r.deltaMs / MIN])).toEqual([
      ["c.com", -90],
      ["b.com", 50],
    ]);
  });
});

describe("limitDays", () => {
  const limits: Limit[] = [
    {
      id: "0192f1c2-7c1e-7a3b-9f00-000000000001",
      pattern: "youtube.com",
      minutes: 30,
      strict: false,
    },
    {
      id: "0192f1c2-7c1e-7a3b-9f00-000000000002",
      pattern: "*.reddit.com",
      minutes: 10,
      strict: false,
    },
  ];

  it("counts the days a limit on one site was kept, and skips wildcard limits", () => {
    const week = [10, 30, 31, 0, 5, 40, 20].map((m) => ({ activeMs: m * MIN }));
    expect(limitDays(limits, new Map([["youtube.com", week]]))).toEqual({
      kept: 5,
      total: 7,
      skipped: 1,
    });
  });

  it("is empty with no limits", () => {
    expect(limitDays([], new Map())).toEqual({ kept: 0, total: 0, skipped: 0 });
  });
});

describe("summarize", () => {
  it("compares this week with the one before, on fixed data", () => {
    const days = [
      ...Array.from({ length: 7 }, (_, i) =>
        day(`2026-10-${String(8 + i).padStart(2, "0")}`, 60, 30, 10),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        day(`2026-10-${String(15 + i).padStart(2, "0")}`, i === 3 ? 90 : 30, 40, 10),
      ),
    ];
    const summary = summarize({
      days,
      comparison: [{ domain: "youtube.com", thisWeekMs: 210 * MIN, lastWeekMs: 420 * MIN }],
      goals: [{ category: "distracting", minutes: 60 }],
      limits: [],
      perSite: new Map(),
    });
    expect(summary.thisWeek).toEqual({
      productiveMs: 280 * MIN,
      neutralMs: 70 * MIN,
      distractingMs: 270 * MIN,
      totalMs: 620 * MIN,
    });
    expect(summary.lastWeek.distractingMs).toBe(420 * MIN);
    expect(summary.changes).toEqual([
      { domain: "youtube.com", thisWeekMs: 210 * MIN, lastWeekMs: 420 * MIN, deltaMs: -210 * MIN },
    ]);
    // Day 4 of this week (90 min) broke the goal; the three days after it kept it.
    expect(summary.goals).toEqual([
      { category: "distracting", minutes: 60, daysKept: 6, days: 7, streak: 3, capped: false },
    ]);
  });
});
