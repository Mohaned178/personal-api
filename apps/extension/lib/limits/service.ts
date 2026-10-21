// M9-02 daily site limits on the device: from the user's limits (they come with the rules), today's
// totals (lib/today.ts) and the segment still open, decide what to tell the user and where to send a
// tab. Everything runs here; nothing is sent anywhere and nothing is logged.
//
// What each outcome does:
// - 10 minutes left (limits longer than 10 minutes): one notification a day;
// - allowance used up: a notification, the badge turns red, and every tab on a site the limit covers
//   moves to the extension's "Time's up" page (no content script). "5 more minutes" on that page
//   adds time for the rest of the day (not in strict mode), and using it up notifies and blocks again;
// - the local midnight starts over: the per-day state is keyed by the local date.
//
// A site the rules drop, a private window and a paused browser are never counted (lib/today.ts and
// the open segment only know pages the rules allowed), so they never reach a limit. A notification
// shows only the pattern the user set the limit on, never a page the user visited.

import type { Limit } from "@personal-api/contracts";
import { CONNECTION_STORAGE_KEY, parseStoredConnection } from "../connect";
import { activeLimits, RULES_STORAGE_KEY } from "../rules/active-rules";
import { sanitizeUrl } from "../sanitize-url";
import { readToday, TODAY_STORAGE_KEY } from "../today";
import {
  blockingLimit,
  type LimitNotice,
  type LimitStatus,
  limitStatuses,
  type OpenUse,
  planNotices,
  SNOOZE_MS,
} from "./evaluate";
import {
  dayRecord,
  LIMITS_NOTIFIED_STORAGE_KEY,
  LIMITS_SNOOZE_STORAGE_KEY,
  readExtra,
  readNotified,
} from "./state";

/** Own periodic alarm. The browser's minimum period is 30 seconds. */
export const LIMITS_ALARM_NAME = "pa-limits";
export const LIMITS_PERIOD_MINUTES = 0.5;

/** The badge colour of a limit that is used up. */
export const LIMIT_BADGE_COLOR = "#d92d20";
export const LIMIT_BADGE_TEXT = "!";

const NOTIFICATION_TITLE = "Personal API";

/** The storage side the limits use. */
export interface LimitsStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const STATE_KEYS = [
  CONNECTION_STORAGE_KEY,
  RULES_STORAGE_KEY,
  TODAY_STORAGE_KEY,
  LIMITS_SNOOZE_STORAGE_KEY,
  LIMITS_NOTIFIED_STORAGE_KEY,
];

interface Loaded {
  limits: Limit[];
  statuses: LimitStatus[];
  raw: Record<string, unknown>;
}

/** Reads everything a status needs in ONE storage call, plus the open segment. */
async function load(deps: {
  storage: Pick<LimitsStorage, "get">;
  now: number;
  readOpen(): Promise<OpenUse | null>;
}): Promise<Loaded> {
  const raw = await deps.storage.get(STATE_KEYS);
  const limits = activeLimits(
    raw[RULES_STORAGE_KEY],
    parseStoredConnection(raw[CONNECTION_STORAGE_KEY]),
  );
  if (limits.length === 0) return { limits, statuses: [], raw };
  let open: OpenUse | null = null;
  try {
    open = await deps.readOpen();
  } catch {
    // The completed segments are still counted.
  }
  const statuses = limitStatuses(
    limits,
    readToday(raw[TODAY_STORAGE_KEY], deps.now),
    open,
    readExtra(raw[LIMITS_SNOOZE_STORAGE_KEY], deps.now),
  );
  return { limits, statuses, raw };
}

/** Where every limit stands now. For the popup and the "Time's up" page. Never rejects. */
export async function readLimitStatuses(deps: {
  storage: Pick<LimitsStorage, "get">;
  now: () => number;
  readOpen(): Promise<OpenUse | null>;
}): Promise<LimitStatus[]> {
  try {
    return (await load({ ...deps, now: deps.now() })).statuses;
  } catch {
    return [];
  }
}

export type SnoozeResult = "snoozed" | "strict" | "unknown";

/**
 * The "Time's up" page's "5 more minutes": adds `SNOOZE_MS` to the limit until local midnight.
 * Refused in strict mode and for a limit that is not in the active config. Never rejects.
 */
export async function snoozeLimit(
  deps: { storage: LimitsStorage; now: () => number },
  limitId: string,
): Promise<SnoozeResult> {
  try {
    const now = deps.now();
    const raw = await deps.storage.get(STATE_KEYS);
    const limit = activeLimits(
      raw[RULES_STORAGE_KEY],
      parseStoredConnection(raw[CONNECTION_STORAGE_KEY]),
    ).find((candidate) => candidate.id === limitId);
    if (limit === undefined) return "unknown";
    if (limit.strict) return "strict";
    const extra = readExtra(raw[LIMITS_SNOOZE_STORAGE_KEY], now);
    const added = (Object.hasOwn(extra, limitId) ? (extra[limitId] ?? 0) : 0) + SNOOZE_MS;
    await deps.storage.set({
      [LIMITS_SNOOZE_STORAGE_KEY]: dayRecord(now, { ...extra, [limitId]: added }),
    });
    return "snoozed";
  } catch {
    return "unknown";
  }
}

export interface LimitTab {
  id?: number;
  url?: string;
  /** Anything other than the boolean `false` is treated as private (fail closed). */
  incognito?: boolean;
}

export interface LimitsDeps {
  storage: LimitsStorage;
  now(): number;
  /** The open focus segment today (lib/limits/open.ts). */
  readOpen(): Promise<OpenUse | null>;
  notifications: {
    create(
      id: string,
      options: { type: "basic"; iconUrl: string; title: string; message: string },
    ): Promise<unknown> | unknown;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void> | void;
    setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
  };
  tabs: {
    query(queryInfo: Record<string, never>): Promise<LimitTab[]>;
    update(tabId: number, properties: { url: string }): Promise<unknown>;
  };
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  };
  /** The extension page a tab on a used-up limit is sent to. Carries the limit id and nothing else. */
  timeUpUrl(limitId: string): string;
  iconUrl: string;
}

export interface LimitsService {
  /** One evaluation. NEVER rejects. Calls run one after another, so none overlaps another. */
  tick(): Promise<void>;
  /** Every background start: creates the periodic alarm if missing, then evaluates once. Never rejects. */
  start(): Promise<void>;
  /** Evaluates for `LIMITS_ALARM_NAME` (returns the promise, for Firefox); `undefined` otherwise. */
  onAlarm(alarm: { name: string }): Promise<void> | undefined;
}

function messageOf(notice: LimitNotice): string {
  return notice.kind === "warning"
    ? `10 minutes left on ${notice.pattern}`
    : `Time's up for ${notice.pattern}`;
}

export function createLimitsService(deps: LimitsDeps): LimitsService {
  async function notify(notice: LimitNotice): Promise<void> {
    try {
      await deps.notifications.create(
        // One id per limit, kind and allowance: a later overrun is a new notification.
        `pa-limit-${notice.limitId}-${notice.kind}-${notice.allowedMs}`,
        {
          type: "basic",
          iconUrl: deps.iconUrl,
          title: NOTIFICATION_TITLE,
          message: messageOf(notice),
        },
      );
    } catch {
      // A notification that cannot be shown is not worth failing the evaluation.
    }
  }

  async function setBadge(reached: boolean): Promise<void> {
    try {
      if (reached) await deps.action.setBadgeBackgroundColor({ color: LIMIT_BADGE_COLOR });
      await deps.action.setBadgeText({ text: reached ? LIMIT_BADGE_TEXT : "" });
    } catch {
      // The badge is cosmetic.
    }
  }

  /** Sends every tab on a site a used-up limit covers to the "Time's up" page. */
  async function block(statuses: readonly LimitStatus[]): Promise<void> {
    if (!statuses.some((status) => status.reached)) return;
    try {
      const tabs = await deps.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined || tab.incognito !== false) continue;
        const page = sanitizeUrl(tab.url);
        if (page === null) continue;
        const limit = blockingLimit(statuses, page.domain);
        if (limit === null) continue;
        try {
          await deps.tabs.update(tab.id, { url: deps.timeUpUrl(limit.id) });
        } catch {
          // The tab may be gone.
        }
      }
    } catch {
      // Tabs could not be listed: the next evaluation tries again.
    }
  }

  async function run(): Promise<void> {
    try {
      const now = deps.now();
      const { statuses, raw } = await load({ storage: deps.storage, now, readOpen: deps.readOpen });

      // The notified state is stored BEFORE the notifications go out: a kill in between loses a
      // notification, which is better than repeating one every 30 seconds.
      const before = readNotified(raw[LIMITS_NOTIFIED_STORAGE_KEY], now);
      const { notices, next } = planNotices(statuses, before);
      const stored = raw[LIMITS_NOTIFIED_STORAGE_KEY];
      const unchanged =
        JSON.stringify(stored ?? null) === JSON.stringify(dayRecord(now, next)) ||
        (stored === undefined && statuses.length === 0);
      if (!unchanged) {
        await deps.storage.set({ [LIMITS_NOTIFIED_STORAGE_KEY]: dayRecord(now, next) });
      }
      for (const notice of notices) await notify(notice);

      await setBadge(statuses.some((status) => status.reached));
      await block(statuses);
    } catch {
      // Fail silent: the next evaluation tries again, and a limit that cannot be read blocks nothing.
    }
  }

  let chain: Promise<unknown> = Promise.resolve();
  function tick(): Promise<void> {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  }

  async function start(): Promise<void> {
    try {
      if (!(await deps.alarms.get(LIMITS_ALARM_NAME))) {
        await deps.alarms.create(LIMITS_ALARM_NAME, { periodInMinutes: LIMITS_PERIOD_MINUTES });
      }
    } catch {
      // Never rejects: the next background start tries again.
    }
    await tick();
  }

  function onAlarm(alarm: { name: string }): Promise<void> | undefined {
    return alarm.name === LIMITS_ALARM_NAME ? tick() : undefined;
  }

  return { tick, start, onAlarm };
}
