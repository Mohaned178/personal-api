import { z } from "zod";
import { globMatches } from "./rule-glob.js";
import { domainPatternSchema } from "./rules.js";

/**
 * Site categories and goals (M9-07). Both live in the dashboard's browser, never on the server:
 * the category list maps domain patterns to a category and the dashboard sums the existing
 * `/v1/activity/domains` totals through it. A site that matches nothing is neutral.
 *
 * A pattern is `example.com` (exactly that site) or `*.example.com` (its subdomains, not the apex).
 */

export const CATEGORIES = ["productive", "neutral", "distracting"] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.output<typeof categorySchema>;

/** Most entries in one list. */
export const CATEGORY_ENTRIES_MAX = 200;

export const categoryEntrySchema = z.strictObject({
  pattern: domainPatternSchema,
  category: categorySchema,
});
export type CategoryEntry = z.output<typeof categoryEntrySchema>;

export const categoryListSchema = z
  .array(categoryEntrySchema)
  .max(CATEGORY_ENTRIES_MAX)
  .refine((list) => new Set(list.map((e) => e.pattern)).size === list.length, {
    message: "Each site can be in the list only once.",
  });
export type CategoryList = z.output<typeof categoryListSchema>;

/** The starting list. Editable in the dashboard; "Reset" brings it back. */
const PRESET_SITES: Record<Exclude<Category, "neutral">, string[]> = {
  productive: [
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "notion.so",
    "docs.google.com",
    "figma.com",
    "linear.app",
    "slack.com",
    "wikipedia.org",
  ],
  distracting: [
    "youtube.com",
    "reddit.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "netflix.com",
    "twitch.tv",
    "9gag.com",
  ],
};

/** Every preset site and its subdomains (`*.example.com` does not match `example.com` itself). */
export const DEFAULT_CATEGORIES: CategoryList = (
  Object.entries(PRESET_SITES) as Array<[Exclude<Category, "neutral">, string[]]>
).flatMap(([category, sites]) =>
  sites.flatMap((site) => [
    { pattern: site, category },
    { pattern: `*.${site}`, category },
  ]),
);

/**
 * The category of a domain: an exact entry wins, then the longest matching `*.` pattern (the most
 * specific), and no match is neutral.
 */
export function categoryOf(domain: string, list: readonly CategoryEntry[]): Category {
  let best: CategoryEntry | null = null;
  for (const entry of list) {
    if (!globMatches(entry.pattern, domain)) continue;
    if (!entry.pattern.includes("*")) return entry.category;
    if (best === null || entry.pattern.length > best.pattern.length) best = entry;
  }
  return best?.category ?? "neutral";
}

/**
 * Goals: at most one per category, in minutes a day. Distracting is a ceiling ("under"),
 * productive is a floor ("at least"). Neutral has no goal.
 */
export const GOAL_MIN_MINUTES = 1;
export const GOAL_MAX_MINUTES = 24 * 60;

const goalMinutesSchema = z.int().min(GOAL_MIN_MINUTES).max(GOAL_MAX_MINUTES);

export const goalsSchema = z.strictObject({
  distracting: goalMinutesSchema.optional(),
  productive: goalMinutesSchema.optional(),
});
export type Goals = z.output<typeof goalsSchema>;
