// M9-02 daily site limits, the pure part: how much of each limit is used, and which notifications
// are due. No storage, no clock, no browser API. Everything here is computed from the user's own
// totals on the device (lib/today.ts) and nothing is ever logged.

import type { Limit } from "@personal-api/contracts";
import { domainMatches } from "@personal-api/rules";
import type { DomainTotals } from "../today";

const MINUTE_MS = 60_000;

/** The "time is almost up" notification fires with this much time left. */
export const WARNING_LEFT_MS = 10 * MINUTE_MS;

/** What "5 more minutes" adds to a limit for the rest of the day. */
export const SNOOZE_MS = 5 * MINUTE_MS;

/** The time the open focus segment has run today, and the domain it is on. */
export interface OpenUse {
  domain: string;
  ms: number;
}

export interface LimitStatus {
  id: string;
  /** The domain pattern the user set the limit on: the only site name a notification may show. */
  pattern: string;
  strict: boolean;
  /** The daily allowance. */
  limitMs: number;
  /** The allowance plus the time "5 more minutes" added today. */
  allowedMs: number;
  /** Time on every site the pattern matches today, including the segment still open. */
  usedMs: number;
  leftMs: number;
  reached: boolean;
}

const has = (record: object, key: string): boolean => Object.hasOwn(record, key);

/** Where every limit stands. `extraMs` is the time added by "5 more minutes", by limit id. */
export function limitStatuses(
  limits: readonly Limit[],
  totals: DomainTotals,
  open: OpenUse | null,
  extraMs: Readonly<Record<string, number>>,
): LimitStatus[] {
  return limits.map((limit) => {
    let usedMs = 0;
    for (const [domain, ms] of Object.entries(totals)) {
      if (domainMatches(limit.pattern, domain)) usedMs += ms;
    }
    if (open !== null && domainMatches(limit.pattern, open.domain)) usedMs += open.ms;
    const limitMs = limit.minutes * MINUTE_MS;
    const allowedMs = limitMs + (has(extraMs, limit.id) ? (extraMs[limit.id] ?? 0) : 0);
    return {
      id: limit.id,
      pattern: limit.pattern,
      strict: limit.strict,
      limitMs,
      allowedMs,
      usedMs,
      leftMs: Math.max(0, allowedMs - usedMs),
      reached: usedMs >= allowedMs,
    };
  });
}

/** What was already notified today for one limit. */
export interface LimitNotified {
  /** The "10 minutes left" notification went out (or was skipped because the limit was already hit). */
  warned: boolean;
  /** The allowance (`allowedMs`) the last "limit reached" notification was for; 0 for none. */
  reachedMs: number;
}

export interface LimitNotice {
  kind: "warning" | "reached";
  limitId: string;
  pattern: string;
  /** The allowance it is about: a later overrun (after "5 more minutes") is a different notice. */
  allowedMs: number;
}

/**
 * Which notifications are due, and the state to store so each goes out once. The warning fires once
 * a day when `WARNING_LEFT_MS` is left, and only for a limit longer than that (a shorter one would
 * warn at the first second). The limit notification fires when the allowance is used up, and again
 * after every "5 more minutes" that is used up in turn.
 */
export function planNotices(
  statuses: readonly LimitStatus[],
  notified: Readonly<Record<string, LimitNotified>>,
): { notices: LimitNotice[]; next: Record<string, LimitNotified> } {
  const notices: LimitNotice[] = [];
  const next: Record<string, LimitNotified> = {};
  for (const status of statuses) {
    const before = has(notified, status.id) ? notified[status.id] : undefined;
    let warned = before?.warned ?? false;
    let reachedMs = before?.reachedMs ?? 0;

    if (
      !warned &&
      status.limitMs > WARNING_LEFT_MS &&
      status.usedMs >= status.limitMs - WARNING_LEFT_MS
    ) {
      warned = true;
      // Already at the limit when first seen (a long gap): the limit notification says it.
      if (status.usedMs < status.limitMs) {
        notices.push({
          kind: "warning",
          limitId: status.id,
          pattern: status.pattern,
          allowedMs: status.allowedMs,
        });
      }
    }
    if (status.reached && reachedMs !== status.allowedMs) {
      reachedMs = status.allowedMs;
      notices.push({
        kind: "reached",
        limitId: status.id,
        pattern: status.pattern,
        allowedMs: status.allowedMs,
      });
    }
    next[status.id] = { warned, reachedMs };
  }
  return { notices, next };
}

/** The first limit that is used up and covers `domain`, or null. */
export function blockingLimit(
  statuses: readonly LimitStatus[],
  domain: string,
): LimitStatus | null {
  return statuses.find((s) => s.reached && domainMatches(s.pattern, domain)) ?? null;
}
