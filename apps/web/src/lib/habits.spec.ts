import { type CategoryList, DEFAULT_CATEGORIES, type Limit } from "@personal-api/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHabits,
  type DayDomains,
  goalMet,
  goalProgress,
  MIN,
  readCategories,
  readGoals,
  saveCategories,
  saveGoals,
  splitByCategory,
  weeklySummary,
} from "./habits";

// Fixed data: youtube.com and reddit.com are distracting and github.com productive in the preset
// list; example.org is neutral.
const day = (date: string, ...sites: Array<[string, number]>): DayDomains => ({
  date,
  domains: sites.map(([domain, minutes]) => ({ domain, activeMs: minutes * MIN, pageVisits: 1 })),
});

afterEach(() => window.localStorage.clear());

describe("split by category", () => {
  it("sums each site into its category and treats unlisted sites as neutral", () => {
    const d = day(
      "d",
      ["youtube.com", 30],
      ["music.youtube.com", 10],
      ["github.com", 50],
      ["example.org", 5],
    );
    expect(splitByCategory(d.domains, DEFAULT_CATEGORIES)).toEqual({
      distracting: 40 * MIN,
      productive: 50 * MIN,
      neutral: 5 * MIN,
    });
  });

  it("uses the edited list", () => {
    const list: CategoryList = [{ pattern: "example.org", category: "distracting" }];
    expect(splitByCategory(day("d", ["example.org", 5]).domains, list).distracting).toBe(5 * MIN);
  });
});

describe("goal met", () => {
  it("is a ceiling for distracting and a floor for productive", () => {
    expect(goalMet("distracting", 60, 60 * MIN, MIN)).toBe(true);
    expect(goalMet("distracting", 60, 61 * MIN, MIN)).toBe(false);
    expect(goalMet("productive", 120, 120 * MIN, MIN)).toBe(true);
    expect(goalMet("productive", 120, 119 * MIN, MIN)).toBe(false);
  });

  it("never counts a day with nothing tracked", () => {
    expect(goalMet("distracting", 60, 0, 0)).toBe(false);
  });
});

describe("goal streak", () => {
  // Oldest first, today last (2026-10-21).
  const days = [
    day("2026-10-15", ["youtube.com", 20], ["github.com", 10]), // met
    day("2026-10-16", ["youtube.com", 90]), // broken: over 60
    day("2026-10-17", ["youtube.com", 10], ["github.com", 30]), // met
    day("2026-10-18", ["github.com", 30]), // met (no distracting time)
    day("2026-10-19", ["youtube.com", 59]), // met
    day("2026-10-20"), // nothing tracked: breaks the streak
    day("2026-10-21", ["youtube.com", 10]),
  ];

  it("counts the finished days in a row that met the goal, ending yesterday", () => {
    // 10-20 had nothing tracked, so the streak is 0 even though 10-17 to 10-19 met the goal.
    expect(goalProgress(days, DEFAULT_CATEGORIES, "distracting", 60).streak).toBe(0);
    const withoutGap = days.filter((d) => d.date !== "2026-10-20");
    expect(goalProgress(withoutGap, DEFAULT_CATEGORIES, "distracting", 60).streak).toBe(3);
  });

  it("stops at the first day that broke the goal", () => {
    const week = [
      ...days.slice(0, 5),
      day("2026-10-20", ["youtube.com", 5]),
      days[6] as DayDomains,
    ];
    expect(goalProgress(week, DEFAULT_CATEGORIES, "distracting", 60).streak).toBe(4);
    const broken = [
      day("a", ["youtube.com", 20]),
      day("b", ["youtube.com", 90]),
      day("c", ["youtube.com", 5]),
      day("d"),
    ];
    expect(goalProgress(broken, DEFAULT_CATEGORIES, "distracting", 60).streak).toBe(1);
  });

  it("shows today without counting it", () => {
    const p = goalProgress(days, DEFAULT_CATEGORIES, "distracting", 60);
    expect(p.todayMs).toBe(10 * MIN);
    expect(p.todayMet).toBe(true);
  });

  it("works for a productive floor", () => {
    const under = goalProgress(
      [
        day("a", ["github.com", 90]),
        day("b", ["github.com", 100]),
        day("c", ["github.com", 30]),
        day("d", ["github.com", 5]),
      ],
      DEFAULT_CATEGORIES,
      "productive",
      60,
    );
    expect(under.streak).toBe(0); // yesterday is under 60
    expect(under.todayMet).toBe(false);
    const over = goalProgress(
      [day("a", ["github.com", 90]), day("b", ["github.com", 80]), day("c")],
      DEFAULT_CATEGORIES,
      "productive",
      60,
    );
    expect(over.streak).toBe(2);
  });

  it("is zero with no days", () => {
    expect(goalProgress([], DEFAULT_CATEGORIES, "distracting", 60)).toMatchObject({
      streak: 0,
      todayMs: 0,
      todayMet: false,
    });
  });
});

describe("weekly summary", () => {
  const last = [
    day("l1", ["youtube.com", 100], ["github.com", 40]),
    day("l2", ["youtube.com", 60]),
    day("l3"),
    day("l4", ["example.org", 10]),
    day("l5"),
    day("l6"),
    day("l7", ["reddit.com", 30]),
  ];
  const now = [
    day("t1", ["youtube.com", 30], ["github.com", 120]),
    day("t2", ["youtube.com", 20], ["reddit.com", 70]),
    day("t3"),
    day("t4", ["example.org", 5]),
    day("t5"),
    day("t6"),
    day("t7", ["github.com", 10]),
  ];
  const limit = (pattern: string, minutes: number): Limit => ({
    id: "0192f1c2-7c1e-7a3b-9f00-0000000000a1",
    pattern,
    minutes,
    strict: false,
  });

  it("compares this week with last week by category", () => {
    const s = weeklySummary([...last, ...now], DEFAULT_CATEGORIES, []);
    expect(s.thisWeek).toEqual({
      distracting: 120 * MIN,
      productive: 130 * MIN,
      neutral: 5 * MIN,
      totalMs: 255 * MIN,
    });
    expect(s.lastWeek).toEqual({
      distracting: 190 * MIN,
      productive: 40 * MIN,
      neutral: 10 * MIN,
      totalMs: 240 * MIN,
    });
  });

  it("counts the limit-days kept, only on days with something tracked", () => {
    // This week has four tracked days (t1, t2, t4, t7); youtube.com is 30m and 20m on two of them.
    const s = weeklySummary([...last, ...now], DEFAULT_CATEGORIES, [limit("youtube.com", 25)]);
    expect(s.limits).toEqual({ kept: 3, checked: 4 });
    // A wildcard limit covers subdomains only, so it never matches the apex.
    expect(weeklySummary(now, DEFAULT_CATEGORIES, [limit("*.youtube.com", 1)]).limits).toEqual({
      kept: 4,
      checked: 4,
    });
  });

  it("lists the biggest rises and falls, three each", () => {
    const s = weeklySummary([...last, ...now], DEFAULT_CATEGORIES, []);
    expect(s.increases.map((r) => [r.domain, r.thisWeekMs - r.lastWeekMs])).toEqual([
      ["github.com", 90 * MIN],
      ["reddit.com", 40 * MIN],
    ]);
    expect(s.decreases.map((r) => [r.domain, r.thisWeekMs - r.lastWeekMs])).toEqual([
      ["youtube.com", -110 * MIN],
      ["example.org", -5 * MIN],
    ]);
  });

  it("copes with fewer than two weeks of days", () => {
    const s = weeklySummary(now.slice(0, 2), DEFAULT_CATEGORIES, []);
    expect(s.lastWeek.totalMs).toBe(0);
    expect(s.thisWeek.totalMs).toBe(240 * MIN);
  });
});

describe("saved list and goals", () => {
  it("falls back to the preset list and no goals when nothing is stored", () => {
    expect(readCategories()).toEqual(DEFAULT_CATEGORIES);
    expect(readGoals()).toEqual({});
  });

  it("round-trips an edited list and goals", () => {
    saveCategories([{ pattern: "example.org", category: "productive" }]);
    saveGoals({ distracting: 45 });
    expect(readCategories()).toEqual([{ pattern: "example.org", category: "productive" }]);
    expect(readGoals()).toEqual({ distracting: 45 });
  });

  it("ignores stored data that does not validate", () => {
    window.localStorage.setItem("personal-api.categories", '[{"pattern":"x","category":"evil"}]');
    window.localStorage.setItem("personal-api.goals", '{"distracting":-5}');
    expect(readCategories()).toEqual(DEFAULT_CATEGORIES);
    expect(readGoals()).toEqual({});
    window.localStorage.setItem("personal-api.categories", "not json");
    expect(readCategories()).toEqual(DEFAULT_CATEGORIES);
  });

  it("forgets both on clear", () => {
    saveCategories([]);
    saveGoals({ productive: 30 });
    clearHabits();
    expect(readCategories()).toEqual(DEFAULT_CATEGORIES);
    expect(readGoals()).toEqual({});
  });
});
