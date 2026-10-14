// Pure core of the Spike A prototype: URL reduction, visit capture and the focus-segment state
// machine. No chrome, DOM or I/O here, so it runs under Vitest unchanged.
//
// background.ts calls these functions INSIDE an IndexedDB readwrite transaction (lib/db.ts
// `transact`): the previous state is read, the function computes synchronously, and the new state
// plus the produced events are written in the same transaction. IndexedDB runs overlapping
// readwrite transactions one after another, so two transitions never overwrite each other, and a
// worker killed before the commit leaves neither the events nor the new state behind.

/** A single focus segment is never longer than this (PLAN §11). */
export const SEGMENT_CAP_MS = 30 * 60 * 1000;
/** chrome.idle detection interval in seconds (PLAN §4: idle after 60 s). */
export const IDLE_DETECTION_S = 60;
/** Heartbeat alarm period. 30 s is the Chrome 120+ minimum for chrome.alarms. */
export const HEARTBEAT_PERIOD_MIN = 0.5;
/**
 * If more than this passed since the last focus step, the machine was not running normally in
 * between (sleep, missed alarms): an open segment ends at the last known alive time. Must stay well
 * above the heartbeat period, alarms can fire a few seconds late.
 */
export const GAP_MS = 90_000;

export interface PageRef {
  domain: string;
  path: string;
}

/**
 * Domain (hostname, no port) + path of an http(s) URL. Query strings, fragments, credentials and
 * ports are dropped here, and the raw URL is never kept anywhere. Anything else returns null.
 */
export function reduceUrl(url: string | undefined): PageRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return { domain: parsed.hostname, path: parsed.pathname || "/" };
}

const pageKey = (page: PageRef): string => `${page.domain}${page.path}`;

export type IdleState = "active" | "idle" | "locked";

export interface OpenSegment extends PageRef {
  tabId: number;
  startedAt: number;
  /** Browser session the segment was opened in (chrome.storage.session, cleared on restart). */
  session: string;
}

/** What the prototype last recorded for a tab, to dedupe recovered visits against late events. */
export interface TabMark {
  page: string | null;
  /** True when the visit was emitted by worker-start reconciliation, not by its own event. */
  recovered: boolean;
  /** When the event (or reconciliation snapshot) behind this mark happened. */
  at: number;
  /** Tab ids are reused across browser sessions: a mark from another session means nothing. */
  session: string;
}

export interface Diagnostics {
  /** page_visited events emitted by the onUpdated listener. */
  captured: number;
  /** page_visited events emitted by worker-start reconciliation (their own event had not landed). */
  recoveredVisits: number;
  /** Late events skipped because reconciliation had already emitted that visit. */
  dedupedEvents: number;
  /** Open segments closed at the last heartbeat after a browser restart. */
  restartRecoveries: number;
  /** Open segments closed at the last heartbeat after a gap (sleep, missed alarms). */
  gapCloses: number;
  /** Segments split at the 30-minute cap. */
  capSplits: number;
}

export interface PersistedState {
  open: OpenSegment | null;
  /** Last focus step: the last moment the prototype knew the browser (and machine) was running. */
  lastAliveAt: number | null;
  tabs: Record<string, TabMark>;
  diag: Diagnostics;
}

export const emptyDiagnostics = (): Diagnostics => ({
  captured: 0,
  recoveredVisits: 0,
  dedupedEvents: 0,
  restartRecoveries: 0,
  gapCloses: 0,
  capSplits: 0,
});

export const initialState = (): PersistedState => ({
  open: null,
  lastAliveAt: null,
  tabs: {},
  diag: emptyDiagnostics(),
});

export interface PageVisitedEvent extends PageRef {
  id: string;
  type: "page_visited";
  ts: number;
}

export interface FocusSegmentEvent extends PageRef {
  id: string;
  type: "focus_segment";
  ts: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export type QueuedEvent = PageVisitedEvent | FocusSegmentEvent;

export interface TabInfo {
  tabId: number;
  url: string | undefined;
  incognito: boolean;
  status?: string | undefined;
}

export interface Transition {
  state: PersistedState;
  events: QueuedEvent[];
}

const copy = (prev: PersistedState): PersistedState => ({
  open: prev.open,
  lastAliveAt: prev.lastAliveAt,
  tabs: { ...prev.tabs },
  diag: { ...prev.diag },
});

const currentMark = (
  state: PersistedState,
  tabId: number,
  session: string,
): TabMark | undefined => {
  const mark = state.tabs[String(tabId)];
  return mark?.session === session ? mark : undefined;
};

export interface CaptureInput {
  /** When chrome.tabs.onUpdated fired with status 'complete'. */
  now: number;
  session: string;
  tab: TabInfo;
}

/**
 * One completed top-level navigation. Runs straight from the listener (not behind the focus
 * chain), so the visit is committed a few milliseconds after Chrome delivered the event.
 */
export function capture(
  prev: PersistedState,
  input: CaptureInput,
  newId: () => string,
): Transition {
  const { now, session, tab } = input;
  const state = copy(prev);
  const events: QueuedEvent[] = [];
  if (tab.incognito) return { state, events };
  const tabId = String(tab.tabId);
  const page = reduceUrl(tab.url);
  if (!page) {
    state.tabs[tabId] = { page: null, recovered: false, at: now, session };
    return { state, events };
  }
  const mark = currentMark(state, tab.tabId, session);
  if (mark?.recovered && mark.page === pageKey(page)) {
    // Reconciliation already emitted this navigation when the worker (re)started.
    state.tabs[tabId] = { ...mark, recovered: false };
    state.diag.dedupedEvents++;
    return { state, events };
  }
  events.push({ id: newId(), type: "page_visited", ...page, ts: now });
  state.tabs[tabId] = { page: pageKey(page), recovered: false, at: now, session };
  state.diag.captured++;
  return { state, events };
}

export interface StepInput {
  /** When the triggering event fired. */
  now: number;
  session: string;
  /** The active tab of the focused window, or null when no browser window has focus. */
  focused: TabInfo | null;
  idle: IdleState;
  /**
   * Every open tab and when that list was read: given on worker start, to recover visits whose
   * own event was lost when the previous worker was killed before committing it.
   */
  openTabs?: { tabs: TabInfo[]; at: number };
}

const sameTarget = (open: OpenSegment, target: OpenSegment | null): boolean =>
  target !== null &&
  open.session === target.session &&
  open.tabId === target.tabId &&
  open.domain === target.domain &&
  open.path === target.path;

/** One focus-state transition (plus visit reconciliation on worker start). */
export function step(prev: PersistedState, input: StepInput, newId: () => string): Transition {
  const { now, session } = input;
  const state = copy(prev);
  const events: QueuedEvent[] = [];

  const closeOpen = (endedAtRaw: number): void => {
    const open = state.open;
    if (!open) return;
    const endedAt = Math.min(Math.max(endedAtRaw, open.startedAt), open.startedAt + SEGMENT_CAP_MS);
    events.push({
      id: newId(),
      type: "focus_segment",
      domain: open.domain,
      path: open.path,
      ts: now,
      startedAt: open.startedAt,
      endedAt,
      durationMs: endedAt - open.startedAt,
    });
    state.open = null;
  };

  // 1. Browser restart: the segment left open by the previous session ends at the last moment
  //    the prototype knew the browser was alive. The downtime never counts and nothing is dropped.
  if (state.open && state.open.session !== session) {
    closeOpen(state.lastAliveAt ?? state.open.startedAt);
    state.diag.restartRecoveries++;
  } else if (state.open && state.lastAliveAt !== null && now - state.lastAliveAt > GAP_MS) {
    // 2. Same session, but no step ran for a while (machine asleep, missed alarms): same rule.
    closeOpen(state.lastAliveAt);
    state.diag.gapCloses++;
  }

  // 3. Visit reconciliation on worker start.
  if (input.openTabs) {
    const alive = new Set<string>();
    for (const tab of input.openTabs.tabs) {
      alive.add(String(tab.tabId));
      if (tab.incognito || tab.status !== "complete") continue;
      const page = reduceUrl(tab.url);
      if (!page) continue;
      const mark = currentMark(state, tab.tabId, session);
      // A mark written after the tab list was read is newer than the list: trust the mark.
      if (mark && (mark.page === pageKey(page) || mark.at > input.openTabs.at)) continue;
      events.push({ id: newId(), type: "page_visited", ...page, ts: now });
      state.tabs[String(tab.tabId)] = {
        page: pageKey(page),
        recovered: true,
        at: input.openTabs.at,
        session,
      };
      state.diag.recoveredVisits++;
    }
    for (const [tabId, mark] of Object.entries(state.tabs)) {
      if (mark.session !== session || (!alive.has(tabId) && mark.at <= input.openTabs.at)) {
        delete state.tabs[tabId];
      }
    }
  }

  // 4. Focus segment. Level-triggered: compare what should be open now with what is open.
  const focusedPage =
    input.focused && !input.focused.incognito ? reduceUrl(input.focused.url) : null;
  const target: OpenSegment | null =
    input.focused && focusedPage && input.idle === "active"
      ? { tabId: input.focused.tabId, ...focusedPage, startedAt: now, session }
      : null;

  // Continuous attention longer than the cap is split into back-to-back capped segments.
  while (
    state.open &&
    sameTarget(state.open, target) &&
    now - state.open.startedAt >= SEGMENT_CAP_MS
  ) {
    const next: OpenSegment = { ...state.open, startedAt: state.open.startedAt + SEGMENT_CAP_MS };
    closeOpen(next.startedAt);
    state.open = next;
    state.diag.capSplits++;
  }

  if (state.open && !sameTarget(state.open, target)) {
    // Idle is reported IDLE_DETECTION_S after the last input; that minute was not attention.
    closeOpen(input.idle === "idle" ? now - IDLE_DETECTION_S * 1000 : now);
  }
  if (!state.open && target) state.open = target;

  state.lastAliveAt = now;
  return { state, events };
}

/** Drops the queue's content and the open segment (the e2e `clear()`); keeps marks and counters. */
export const cleared = (prev: PersistedState): Transition => ({
  state: { ...copy(prev), open: null },
  events: [],
});
