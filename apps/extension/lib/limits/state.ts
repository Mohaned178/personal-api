// M9-02 what the limits remember for the current local day, in `browser.storage.local`:
// - `limitsSnooze`: the time "5 more minutes" added, by limit id. Written by the "Time's up" page,
//   read by the background and the popup.
// - `limitsNotified`: which notifications already went out, by limit id. Written by the background.
// Two keys with one writer each, so neither side overwrites the other. Both hold the local date
// and are empty on any other day, which is the reset at local midnight. They hold limit ids and
// numbers only: never a URL, a path or a domain.

import { localDate } from "../today";
import type { LimitNotified } from "./evaluate";

export const LIMITS_SNOOZE_STORAGE_KEY = "limitsSnooze";
export const LIMITS_NOTIFIED_STORAGE_KEY = "limitsNotified";

export interface DayRecord<T> {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  items: Record<string, T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Today's items from a stored value: empty for another day, or anything malformed. */
function readDay<T>(
  value: unknown,
  now: number,
  isItem: (item: unknown) => item is T,
): Record<string, T> {
  if (!isRecord(value) || value.date !== localDate(now) || !isRecord(value.items)) return {};
  const entries = Object.entries(value.items);
  if (!entries.every(([, item]) => isItem(item))) return {};
  return Object.fromEntries(entries) as Record<string, T>;
}

const isDuration = (item: unknown): item is number =>
  typeof item === "number" && Number.isFinite(item) && item >= 0;

const isNotified = (item: unknown): item is LimitNotified =>
  isRecord(item) && typeof item.warned === "boolean" && isDuration(item.reachedMs);

/** Time added by "5 more minutes" today, by limit id. */
export const readExtra = (value: unknown, now: number): Record<string, number> =>
  readDay(value, now, isDuration);

/** What already went out today, by limit id. */
export const readNotified = (value: unknown, now: number): Record<string, LimitNotified> =>
  readDay(value, now, isNotified);

export function dayRecord<T>(now: number, items: Record<string, T>): DayRecord<T> {
  return { date: localDate(now), items };
}
