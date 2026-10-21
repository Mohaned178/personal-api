import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  categoryDaySchema,
  categoryRuleSaveSchema,
  GOAL_MAX_MINUTES,
  goalSaveSchema,
  goalSchema,
  PRESET_CATEGORY_DOMAINS,
} from "./categories.js";
import { domainPatternSchema } from "./rules.js";

describe("PRESET_CATEGORY_DOMAINS", () => {
  const all = [...PRESET_CATEGORY_DOMAINS.productive, ...PRESET_CATEGORY_DOMAINS.distracting];

  it("holds only valid plain domains", () => {
    for (const domain of all) {
      expect(domainPatternSchema.safeParse(domain).success, domain).toBe(true);
      expect(domain.startsWith("*."), domain).toBe(false);
    }
  });

  it("lists no site twice, in one list or across both", () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it("has no site that is a subdomain of a site in the other list", () => {
    for (const a of PRESET_CATEGORY_DOMAINS.productive) {
      for (const b of PRESET_CATEGORY_DOMAINS.distracting) {
        expect(a.endsWith(`.${b}`) || b.endsWith(`.${a}`), `${a} / ${b}`).toBe(false);
      }
    }
  });
});

describe("categoryRuleSaveSchema", () => {
  it.each(CATEGORIES)("accepts %s for a domain and a wildcard", (category) => {
    expect(categoryRuleSaveSchema.safeParse({ pattern: "example.com", category }).success).toBe(
      true,
    );
    expect(categoryRuleSaveSchema.safeParse({ pattern: "*.example.com", category }).success).toBe(
      true,
    );
  });

  it.each([
    ["an unknown category", { pattern: "example.com", category: "evil" }],
    ["a missing category", { pattern: "example.com" }],
    ["a url", { pattern: "https://example.com/a", category: "neutral" }],
    ["an owner field", { pattern: "example.com", category: "neutral", userId: "u" }],
  ])("rejects %s", (_name, body) => {
    expect(categoryRuleSaveSchema.safeParse(body).success).toBe(false);
  });
});

describe("goals", () => {
  it("takes whole minutes up to a day", () => {
    expect(goalSaveSchema.safeParse({ minutes: 60 }).success).toBe(true);
    expect(goalSaveSchema.safeParse({ minutes: GOAL_MAX_MINUTES }).success).toBe(true);
  });

  it.each([0, -1, 1.5, GOAL_MAX_MINUTES + 1])("rejects %s minutes", (minutes) => {
    expect(goalSaveSchema.safeParse({ minutes }).success).toBe(false);
  });

  it("is a ceiling on distracting or neutral time, never productive", () => {
    expect(goalSchema.safeParse({ category: "distracting", minutes: 60 }).success).toBe(true);
    expect(goalSchema.safeParse({ category: "productive", minutes: 60 }).success).toBe(false);
  });
});

describe("categoryDaySchema", () => {
  it("is a date with a time per category", () => {
    const day = { date: "2026-10-21", productiveMs: 1, neutralMs: 0, distractingMs: 2 };
    expect(categoryDaySchema.safeParse(day).success).toBe(true);
    expect(categoryDaySchema.safeParse({ ...day, date: "21/10" }).success).toBe(false);
  });
});
