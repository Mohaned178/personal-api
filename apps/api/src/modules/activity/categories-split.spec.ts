import type { CategoryRule } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { classify } from "../categories/classify";
import { splitByCategory } from "./categories-split";

const MIN = 60_000;
const rule = (pattern: string, category: CategoryRule["category"]): CategoryRule => ({
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  pattern,
  category,
});
const day = (date: string, activeMs: number) => ({ date, activeMs, pageVisits: 1 });
const site = (domain: string, date: string, activeMs: number) => ({
  domain,
  date,
  activeMs,
  nightMs: 0,
});

describe("classify", () => {
  it("uses the built-in list for a site and its subdomains, else neutral", () => {
    expect(classify("github.com", [])).toBe("productive");
    expect(classify("gist.github.com", [])).toBe("productive");
    expect(classify("m.youtube.com", [])).toBe("distracting");
    expect(classify("example.org", [])).toBe("neutral");
  });

  it("does not treat a look-alike domain as a preset", () => {
    expect(classify("notgithub.com", [])).toBe("neutral");
    expect(classify("youtube.com.evil.example", [])).toBe("neutral");
  });

  it("lets an override beat the built-in list", () => {
    expect(classify("youtube.com", [rule("youtube.com", "productive")])).toBe("productive");
    expect(classify("github.com", [rule("*.github.com", "distracting")])).toBe("productive");
    expect(classify("gist.github.com", [rule("*.github.com", "distracting")])).toBe("distracting");
  });

  it("prefers an exact override, then the longer wildcard", () => {
    const overrides = [
      rule("*.example.com", "distracting"),
      rule("*.docs.example.com", "productive"),
      rule("a.docs.example.com", "neutral"),
    ];
    expect(classify("x.example.com", overrides)).toBe("distracting");
    expect(classify("b.docs.example.com", overrides)).toBe("productive");
    expect(classify("a.docs.example.com", overrides)).toBe("neutral");
  });
});

describe("splitByCategory", () => {
  it("splits each day and leaves the rest as neutral", () => {
    const days = [day("2026-10-20", 100 * MIN), day("2026-10-21", 50 * MIN)];
    const domainDays = [
      site("github.com", "2026-10-20", 30 * MIN),
      site("youtube.com", "2026-10-20", 20 * MIN),
      site("example.org", "2026-10-20", 10 * MIN),
      site("youtube.com", "2026-10-21", 5 * MIN),
    ];
    expect(splitByCategory(days, domainDays, [])).toEqual([
      {
        date: "2026-10-20",
        productiveMs: 30 * MIN,
        distractingMs: 20 * MIN,
        neutralMs: 50 * MIN,
      },
      { date: "2026-10-21", productiveMs: 0, distractingMs: 5 * MIN, neutralMs: 45 * MIN },
    ]);
  });

  it("changes the past when an override is added", () => {
    const days = [day("2026-10-20", 20 * MIN)];
    const domainDays = [site("youtube.com", "2026-10-20", 20 * MIN)];
    const [before] = splitByCategory(days, domainDays, []);
    const [after] = splitByCategory(days, domainDays, [rule("youtube.com", "productive")]);
    expect(before?.distractingMs).toBe(20 * MIN);
    expect(after).toMatchObject({ productiveMs: 20 * MIN, distractingMs: 0, neutralMs: 0 });
  });

  it("never lets the parts exceed the day total", () => {
    const days = [day("2026-10-20", 10 * MIN)];
    const domainDays = [
      site("github.com", "2026-10-20", 8 * MIN),
      site("youtube.com", "2026-10-20", 8 * MIN),
    ];
    const [split] = splitByCategory(days, domainDays, []);
    expect(split).toEqual({
      date: "2026-10-20",
      productiveMs: 8 * MIN,
      distractingMs: 2 * MIN,
      neutralMs: 0,
    });
  });

  it("leaves out days without activity and returns nothing for no days", () => {
    expect(splitByCategory([day("2026-10-20", 0)], [], [])).toEqual([]);
    expect(splitByCategory([], [site("github.com", "2026-10-20", MIN)], [])).toEqual([]);
  });
});
