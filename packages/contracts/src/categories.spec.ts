import { describe, expect, it } from "vitest";
import {
  CATEGORY_ENTRIES_MAX,
  categoryListSchema,
  categoryOf,
  DEFAULT_CATEGORIES,
  goalsSchema,
} from "./categories.js";

describe("category list (M9-07)", () => {
  it("validates the preset list, with each site once", () => {
    expect(categoryListSchema.safeParse(DEFAULT_CATEGORIES).success).toBe(true);
    expect(DEFAULT_CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(DEFAULT_CATEGORIES.map((e) => e.category))).toEqual(
      new Set(["productive", "distracting"]),
    );
  });

  it.each([
    ["a bad pattern", [{ pattern: "not a domain", category: "distracting" }]],
    ["an unknown category", [{ pattern: "a.com", category: "evil" }]],
    ["an extra field", [{ pattern: "a.com", category: "neutral", note: "x" }]],
    [
      "a duplicate site",
      [
        { pattern: "a.com", category: "neutral" },
        { pattern: "a.com", category: "distracting" },
      ],
    ],
    [
      "too many entries",
      Array.from({ length: CATEGORY_ENTRIES_MAX + 1 }, (_, i) => ({
        pattern: `site${i}.example`,
        category: "neutral",
      })),
    ],
  ])("rejects %s", (_name, list) => {
    expect(categoryListSchema.safeParse(list).success).toBe(false);
  });

  it("puts a site in the category of its entry, subdomains included", () => {
    expect(categoryOf("youtube.com", DEFAULT_CATEGORIES)).toBe("distracting");
    expect(categoryOf("music.youtube.com", DEFAULT_CATEGORIES)).toBe("distracting");
    expect(categoryOf("github.com", DEFAULT_CATEGORIES)).toBe("productive");
  });

  it("treats a site outside the list as neutral", () => {
    expect(categoryOf("example.org", DEFAULT_CATEGORIES)).toBe("neutral");
    expect(categoryOf("notyoutube.com", DEFAULT_CATEGORIES)).toBe("neutral");
    expect(categoryOf("youtube.com", [])).toBe("neutral");
  });

  it("prefers an exact entry, then the longest wildcard", () => {
    const list = [
      { pattern: "*.example.com", category: "distracting" },
      { pattern: "*.docs.example.com", category: "productive" },
      { pattern: "work.example.com", category: "neutral" },
    ] as const;
    expect(categoryOf("work.example.com", list)).toBe("neutral");
    expect(categoryOf("a.docs.example.com", list)).toBe("productive");
    expect(categoryOf("a.example.com", list)).toBe("distracting");
    expect(categoryOf("example.com", list)).toBe("neutral");
  });
});

describe("goals (M9-07)", () => {
  it("accepts a distracting ceiling, a productive floor, both or neither", () => {
    expect(goalsSchema.safeParse({}).success).toBe(true);
    expect(goalsSchema.safeParse({ distracting: 60 }).success).toBe(true);
    expect(goalsSchema.safeParse({ distracting: 60, productive: 240 }).success).toBe(true);
  });

  it.each([
    { distracting: 0 },
    { distracting: 1441 },
    { distracting: 1.5 },
    { neutral: 30 },
    { productive: "60" },
  ])("rejects %j", (goals) => {
    expect(goalsSchema.safeParse(goals).success).toBe(false);
  });
});
