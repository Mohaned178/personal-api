// M8-04 the popup's "Today": time per site, computed on the device.
//
// Only focus segments the rules kept are counted: the counter sits between the rule layer and the
// durable store (lib/queue/wire.ts), so it sees exactly the events a commit queued, after the commit
// succeeded. A dropped site, a private window or a paused capture never reaches it. Nothing is read
// from the server, so the ingest key stays ingest-only.
//
// `browser.storage.local` holds ONE entry: `{ date, ms }` for the local date. A segment of another
// day is not counted, and the previous day's entry is replaced at the first count of a new day or
// deleted by `prune` (background start and every alarm). Nothing here is ever logged.

import type { CapturedEvent, CaptureStore } from "./capture";
import { sanitizeUrl } from "./sanitize-url";

export const TODAY_STORAGE_KEY = "todayTotals";

/** Milliseconds per domain. */
export type DomainTotals = Record<string, number>;

interface StoredToday {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  ms: DomainTotals;
}

export interface TodayStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** `YYYY-MM-DD` of `ms` in the browser's time zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The stored entry, or null when it is absent or malformed. */
function parseStored(value: unknown): StoredToday | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { date, ms } = value as Record<string, unknown>;
  if (typeof date !== "string") return null;
  if (typeof ms !== "object" || ms === null || Array.isArray(ms)) return null;
  const entries = Object.entries(ms);
  if (!entries.every(([, total]) => isDuration(total))) return null;
  return { date, ms: Object.fromEntries(entries) as DomainTotals };
}

/** Today's totals from a stored value: empty for another day, or anything malformed. */
export function readToday(value: unknown, now: number): DomainTotals {
  const stored = parseStored(value);
  return stored !== null && stored.date === localDate(now) ? stored.ms : {};
}

/** The longest `limit` sites, longest first. */
export function topSites(totals: DomainTotals, limit = 5): { domain: string; ms: number }[] {
  return Object.entries(totals)
    .map(([domain, ms]) => ({ domain, ms }))
    .sort((a, b) => b.ms - a.ms || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

export interface TodayCounter {
  /** Adds the committed focus segments of today. Never rejects. */
  add(events: readonly CapturedEvent[]): Promise<void>;
  /** Deletes an entry of another day, or a malformed one. Never rejects. */
  prune(): Promise<void>;
}

/** All storage work runs one after another, in call order, so concurrent adds lose no time. */
export function createTodayCounter(deps: {
  storage: TodayStorage;
  now: () => number;
}): TodayCounter {
  const { storage, now } = deps;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = chain.then(work).catch(() => undefined);
    chain = run;
    return run;
  };

  return {
    add(events) {
      const today = localDate(now());
      const counted: [string, number][] = [];
      for (const event of events) {
        if (event.type !== "browser.focus_segment") continue;
        const { domain, durationMs } = event.data as Record<string, unknown>;
        if (typeof domain !== "string" || !isDuration(durationMs)) continue;
        if (localDate(Date.parse(event.occurredAt)) !== today) continue;
        counted.push([domain, durationMs]);
      }
      if (counted.length === 0) return Promise.resolve();
      return enqueue(async () => {
        const raw = await storage.get(TODAY_STORAGE_KEY);
        const stored = parseStored(raw[TODAY_STORAGE_KEY]);
        // Another day (or nothing, or garbage) starts over: the previous day is gone.
        const ms: DomainTotals = stored !== null && stored.date === today ? { ...stored.ms } : {};
        for (const [domain, durationMs] of counted) {
          ms[domain] = (Object.hasOwn(ms, domain) ? (ms[domain] ?? 0) : 0) + durationMs;
        }
        await storage.set({ [TODAY_STORAGE_KEY]: { date: today, ms } });
      });
    },
    prune() {
      return enqueue(async () => {
        const raw = await storage.get(TODAY_STORAGE_KEY);
        if (!(TODAY_STORAGE_KEY in raw)) return;
        const stored = parseStored(raw[TODAY_STORAGE_KEY]);
        if (stored === null || stored.date !== localDate(now())) {
          await storage.remove(TODAY_STORAGE_KEY);
        }
      });
    },
  };
}

/**
 * Wraps the durable store: once a commit succeeded, the events it queued are counted. Put it
 * BELOW the rule store, so the events are the ones the rules kept. A failed commit counts nothing,
 * and a failed count never fails the commit.
 */
export function createTodayStore(deps: {
  store: CaptureStore;
  counter: TodayCounter;
}): CaptureStore {
  return {
    async transact(compute) {
      let queued: readonly CapturedEvent[] = [];
      await deps.store.transact((prev) => {
        const transition = compute(prev);
        queued = transition.events;
        return transition;
      });
      await deps.counter.add(queued);
    },
  };
}

/**
 * The popup's "Stop tracking this site" link: the dashboard's Rules page with the domain in the
 * fragment, which the browser never sends to the server (invariant 6). Null for a private tab, a
 * page that is never collected, or the server itself.
 */
export function stopTrackingUrl(
  serverOrigin: string,
  tab: { url?: string; incognito?: boolean } | undefined,
): string | null {
  if (tab === undefined || tab.incognito !== false) return null;
  const page = sanitizeUrl(tab.url);
  if (page === null) return null;
  try {
    if (new URL(tab.url ?? "").origin === serverOrigin) return null;
  } catch {
    return null;
  }
  return `${serverOrigin}/rules#drop=${encodeURIComponent(page.domain)}`;
}

/** "<1 min", "12 min", "1 h 5 min": what the popup shows next to a site. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}
