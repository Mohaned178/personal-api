import { z } from "zod";
import { utcDateTimeSchema } from "./primitives.js";
import { domainPatternSchema } from "./rules.js";

/**
 * Site categories, goals and the per-day split (M9-07). Every site is `productive`, `neutral` or
 * `distracting`. A built-in preset list says which well-known sites are productive or distracting;
 * everything else is neutral. The user edits the list with overrides (`/v1/categories`): a pattern
 * (`example.com`, exactly that site, or `*.example.com`, its subdomains) and a category, which beat
 * the presets. The mapping is applied when the numbers are computed (`GET /v1/activity/categories`),
 * so an edit also changes the past, and no event is rewritten. A goal (`/v1/goals/:category`) is a
 * daily ceiling on one category ("under 60 minutes of distracting sites"). All session only.
 *
 * Requests are strict: the server sets ids and owner (invariant 4). Issue messages are fixed
 * strings (invariant 6): a pattern is a domain the user browses.
 */

export const CATEGORIES = ["productive", "neutral", "distracting"] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.output<typeof categorySchema>;

/** Categories a daily ceiling makes sense for: more productive time is never a problem. */
export const GOAL_CATEGORIES = ["distracting", "neutral"] as const;
export const goalCategorySchema = z.enum(GOAL_CATEGORIES);
export type GoalCategory = z.output<typeof goalCategorySchema>;

/** Most overrides one user can have. Creating more is a 409. */
export const CATEGORY_RULES_PER_USER_MAX = 200;
export const GOAL_MIN_MINUTES = 1;
export const GOAL_MAX_MINUTES = 24 * 60;

export const CATEGORY_NOT_FOUND_CODE = "category.not_found";
export const CATEGORY_LIMIT_REACHED_CODE = "category.limit_reached";
export const CATEGORY_PATTERN_TAKEN_CODE = "category.pattern_taken";
export const GOAL_NOT_FOUND_CODE = "goal.not_found";

/**
 * The built-in list. A domain here covers itself and its subdomains. A site in neither list is
 * neutral. Shown in the dashboard so the user can see what an override changes.
 */
export const PRESET_CATEGORY_DOMAINS = {
  productive: [
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "docs.google.com",
    "notion.so",
    "linear.app",
    "figma.com",
    "atlassian.net",
    "slack.com",
    "zoom.us",
    "coursera.org",
    "khanacademy.org",
    "wikipedia.org",
    "npmjs.com",
    "docs.python.org",
    "learn.microsoft.com",
    "claude.ai",
  ],
  distracting: [
    "youtube.com",
    "netflix.com",
    "twitch.tv",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "9gag.com",
    "buzzfeed.com",
    "pinterest.com",
    "snapchat.com",
    "primevideo.com",
    "disneyplus.com",
    "hulu.com",
    "imgur.com",
    "tumblr.com",
  ],
} as const satisfies Record<"productive" | "distracting", readonly string[]>;

/** What a user submits to create or replace an override. */
export const categoryRuleSaveSchema = z.strictObject({
  pattern: domainPatternSchema,
  category: categorySchema,
});
export type CategoryRuleSave = z.output<typeof categoryRuleSaveSchema>;

/** A stored override. */
export const categoryRuleSchema = z.strictObject({
  id: z.uuid(),
  pattern: domainPatternSchema,
  category: categorySchema,
});
export type CategoryRule = z.output<typeof categoryRuleSchema>;

/** `GET /v1/categories`: every override, by pattern, and the built-in list. */
export const categoryListResponseSchema = z.strictObject({
  rules: z.array(categoryRuleSchema).max(CATEGORY_RULES_PER_USER_MAX),
  presets: z.strictObject({
    productive: z.array(z.string()),
    distracting: z.array(z.string()),
  }),
});
export type CategoryListResponse = z.output<typeof categoryListResponseSchema>;

/** `PUT /v1/goals/:category` body. */
export const goalSaveSchema = z.strictObject({
  minutes: z.int().min(GOAL_MIN_MINUTES).max(GOAL_MAX_MINUTES),
});
export type GoalSave = z.output<typeof goalSaveSchema>;

export const goalSchema = z.strictObject({
  category: goalCategorySchema,
  minutes: z.int().min(GOAL_MIN_MINUTES).max(GOAL_MAX_MINUTES),
});
export type Goal = z.output<typeof goalSchema>;

/** `GET /v1/goals`: every goal (at most one per category). */
export const goalListResponseSchema = z.strictObject({
  goals: z.array(goalSchema).max(GOAL_CATEGORIES.length),
});
export type GoalListResponse = z.output<typeof goalListResponseSchema>;

/** `GET /v1/activity/categories` query: same range as the other activity routes. */
export const activityCategoriesQuerySchema = z.strictObject({
  from: utcDateTimeSchema.optional(),
  to: utcDateTimeSchema.optional(),
});
export type ActivityCategoriesQuery = z.output<typeof activityCategoriesQuerySchema>;

/** One local day that has activity, split by category. Days with none are left out. */
export const categoryDaySchema = z.strictObject({
  /** `YYYY-MM-DD` in `timeZone`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productiveMs: z.number().int().min(0),
  neutralMs: z.number().int().min(0),
  distractingMs: z.number().int().min(0),
});
export type CategoryDay = z.output<typeof categoryDaySchema>;

export const activityCategoriesResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  timeZone: z.string(),
  days: z.array(categoryDaySchema),
});
export type ActivityCategoriesResponse = z.output<typeof activityCategoriesResponseSchema>;
