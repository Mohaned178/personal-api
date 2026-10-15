// M2-04 capture engine, pure part: the persisted state record and every transition on it
// (ADR 0002 decision 2). Each function here runs synchronously INSIDE `CaptureStore.transact`:
// it reads the last committed state, computes, and returns the new state plus the events it
// produced. No browser API, clock or I/O here; everything it needs comes in as input, and every
// page it is handed was already sanitized (M2-03) and checked against the rule gate.

import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";
import type { SanitizedUrl } from "../sanitize-url";
import { GAP_MS, IDLE_DETECTION_S, SESSION_IDLE_TIMEOUT_MS } from "./constants";
import type { CapturedEvent, CaptureIdleState, CaptureState, CaptureTransition } from "./types";

const STATE_VERSION = 1;
const IDLE_OFFSET_MS = IDLE_DETECTION_S * 1000;

/** What was last recorded for a tab in one browser session (tab ids are reused after a restart). */
type TabMark = {
  /** Random tab reference used on this tab's events. */
  ref: string;
  /** Browser session the mark belongs to. */
  session: string;
  /** `domain + path` of the last visit emitted for the tab; null when the last page was not. */
  page: string | null;
  /** The visit was emitted by start-up reconciliation; its late event is skipped once. */
  recovered: boolean;
  /** Time of the event (or of the tab listing) behind this mark. */
  at: number;
};

type OpenSegment = {
  tabId: number;
  domain: string;
  path: string;
  startedAt: number;
  /** Browser session the segment was opened in. */
  session: string;
};

type EngineState = {
  v: typeof STATE_VERSION;
  open: OpenSegment | null;
  /** Last focus step: the last moment the browser (and machine) was known alive. */
  alive: { at: number; session: string } | null;
  /** Time of the last input before the current idle or lock period; null while active. */
  idleSince: number | null;
  /** The browsing session (session_started / session_ended). */
  sess: {
    open: boolean;
    /** Browser session in which the last session_started was emitted. */
    of: string | null;
    /** End time for a session left open by a previous browser session, fixed on first sight. */
    endAt: number | null;
  };
  tabs: Record<string, TabMark>;
};

export interface Ids {
  newId: () => string;
  newTabRef: () => string;
}

export const pageKey = (page: SanitizedUrl): string => `${page.domain}${page.path}`;

const iso = (ms: number): string => new Date(ms).toISOString();

const initialState = (): EngineState => ({
  v: STATE_VERSION,
  open: null,
  alive: null,
  idleSince: null,
  sess: { open: false, of: null, endAt: null },
  tabs: {},
});

/** A private copy of the stored state, or a fresh one (nothing stored yet, or an unknown version). */
function load(prev: CaptureState | null): EngineState {
  if (prev !== null && prev.v === STATE_VERSION) return structuredClone(prev) as EngineState;
  return initialState();
}

type EventOf<T extends CapturedEvent["type"]> = Extract<CapturedEvent, { type: T }>;

function makeEvent<T extends CapturedEvent["type"]>(
  ids: Ids,
  type: T,
  at: number,
  data: EventOf<T>["data"],
): CapturedEvent {
  return { id: ids.newId(), type, typeVersion: 1, occurredAt: iso(at), data } as CapturedEvent;
}

function currentMark(state: EngineState, tabId: number, session: string): TabMark | undefined {
  const mark = state.tabs[String(tabId)];
  return mark?.session === session ? mark : undefined;
}

/** The page of the open segment, so the engine can ask the gate about it before closing it. */
export function openPage(prev: CaptureState | null): SanitizedUrl | null {
  const open = load(prev).open;
  return open ? { domain: open.domain, path: open.path } : null;
}

/** The unchanged state (a read). */
export const unchanged = (prev: CaptureState | null): CaptureTransition => ({
  state: load(prev),
  events: [],
});

// --------------------------------------------------------------------------------------------
// capture path (ADR 0002 option B): one transaction straight from the listener

export interface VisitInput {
  now: number;
  session: string;
  tabId: number;
  /** The sanitized page, or null when it is not collected (unsupported, or the gate said no). */
  page: SanitizedUrl | null;
}

/** A completed navigation in a non-incognito tab. */
export function captureVisit(
  prev: CaptureState | null,
  input: VisitInput,
  ids: Ids,
): CaptureTransition {
  const { now, session, tabId, page } = input;
  const state = load(prev);
  const id = String(tabId);
  const mark = currentMark(state, tabId, session);
  if (page === null) {
    // Nothing about the page is kept: a later reconciliation must not match an older page.
    if (mark) state.tabs[id] = { ...mark, page: null, recovered: false, at: now };
    return { state, events: [] };
  }
  const key = pageKey(page);
  if (mark?.recovered && mark.page === key) {
    // Start-up reconciliation already emitted this navigation: skip its late event once.
    state.tabs[id] = { ...mark, recovered: false };
    return { state, events: [] };
  }
  const ref = mark?.ref ?? ids.newTabRef();
  const event = makeEvent(ids, "browser.page_visited", now, { ...page, tabRef: ref });
  state.tabs[id] = { ref, session, page: key, recovered: false, at: now };
  return { state, events: [event] };
}

export interface TabOpenedInput {
  now: number;
  session: string;
  tabId: number;
  /** Sanitized domain the gate allowed, if any. */
  domain: string | null;
  /** The gate allows events without a page. */
  emit: boolean;
}

/** A new non-incognito tab: a fresh tab reference, and `tab_opened` if allowed. */
export function tabOpened(
  prev: CaptureState | null,
  input: TabOpenedInput,
  ids: Ids,
): CaptureTransition {
  const { now, session, tabId, domain, emit } = input;
  const state = load(prev);
  const ref = ids.newTabRef();
  state.tabs[String(tabId)] = { ref, session, page: null, recovered: false, at: now };
  if (!emit) return { state, events: [] };
  const data = domain === null ? { tabRef: ref } : { tabRef: ref, domain };
  return { state, events: [makeEvent(ids, "browser.tab_opened", now, data)] };
}

export interface TabClosedInput {
  now: number;
  session: string;
  tabId: number;
  emit: boolean;
}

/** A tab was removed: `tab_closed` once, only for a tab this browser session knows. */
export function tabClosed(
  prev: CaptureState | null,
  input: TabClosedInput,
  ids: Ids,
): CaptureTransition {
  const { now, session, tabId, emit } = input;
  const state = load(prev);
  const mark = currentMark(state, tabId, session);
  delete state.tabs[String(tabId)];
  if (!mark || !emit) return { state, events: [] };
  return { state, events: [makeEvent(ids, "browser.tab_closed", now, { tabRef: mark.ref })] };
}

// --------------------------------------------------------------------------------------------
// focus step (ADR 0002 decisions 4 to 8): level-triggered, serialized by the engine

export interface FocusStepInput {
  /** Event time. */
  now: number;
  session: string;
  /** The sanitized page of the active tab of the focused, non-incognito window. */
  target: { tabId: number; page: SanitizedUrl } | null;
  /** null: unknown (the query failed), which is never treated as active. */
  idle: CaptureIdleState | null;
  /** Page keys the gate allowed in this step. A page not in here is never emitted or kept. */
  allowed: ReadonlySet<string>;
  /** The gate allows events without a page (session events). */
  sessionsAllowed: boolean;
  /** Background start: the open tabs, listed at `at` (sanitized, complete, non-incognito pages). */
  reconcile?: { at: number; tabIds: number[]; pages: { tabId: number; page: SanitizedUrl }[] };
}

export function focusStep(
  prev: CaptureState | null,
  input: FocusStepInput,
  ids: Ids,
): CaptureTransition {
  const { now, session, allowed } = input;
  const state = load(prev);
  const events: CapturedEvent[] = [];

  const emitSegment = (open: OpenSegment, start: number, end: number): void => {
    events.push(
      makeEvent(ids, "browser.focus_segment", end, {
        domain: open.domain,
        path: open.path,
        startedAt: iso(start),
        endedAt: iso(end),
        durationMs: end - start,
      }),
    );
  };

  /**
   * Closes the open segment at `end`. Longer than the cap: split into back-to-back capped
   * segments first, so nothing above the cap is lost. Zero or negative length: dropped. A page the
   * gate does not allow (any more) is dropped too.
   */
  const close = (end: number): void => {
    const open = state.open;
    if (!open) return;
    state.open = null;
    if (!allowed.has(pageKey(open))) return;
    let start = open.startedAt;
    while (end - start > FOCUS_SEGMENT_MAX_MS) {
      emitSegment(open, start, start + FOCUS_SEGMENT_MAX_MS);
      start += FOCUS_SEGMENT_MAX_MS;
    }
    if (end > start) emitSegment(open, start, end);
  };

  const restarted = state.alive !== null && state.alive.session !== session;

  // 1. Restart and gap recovery: end at the last moment known alive, never at the current time.
  if (state.open) {
    if (state.open.session !== session) {
      const alive = state.alive;
      close(alive && alive.session === state.open.session ? alive.at : state.open.startedAt);
    } else if (state.alive && now - state.alive.at > GAP_MS) {
      close(state.alive.at);
    }
  }
  if (state.sess.open && state.sess.of !== session && state.sess.endAt === null) {
    state.sess.endAt = state.alive?.at ?? now;
  }

  // 2. Idle bookkeeping. Idle is reported IDLE_DETECTION_S after the last input.
  if (restarted) state.idleSince = null;
  const idleBefore = state.idleSince;
  if (input.idle === "active") state.idleSince = null;
  else if (input.idle === "idle") state.idleSince ??= now - IDLE_OFFSET_MS;
  else if (input.idle === "locked") state.idleSince ??= now;

  // 3. Reconciliation of open tabs at background start.
  if (input.reconcile) reconcile(state, input.reconcile, input, events, ids);

  // 4. Focus segment: compare what should be open now with what is open.
  const target =
    input.target && input.idle === "active" && allowed.has(pageKey(input.target.page))
      ? input.target
      : null;
  const open = state.open;
  if (
    open &&
    target &&
    open.tabId === target.tabId &&
    open.domain === target.page.domain &&
    open.path === target.page.path
  ) {
    // Same page still in focus: split continuous attention at the cap.
    while (now - open.startedAt >= FOCUS_SEGMENT_MAX_MS) {
      emitSegment(open, open.startedAt, open.startedAt + FOCUS_SEGMENT_MAX_MS);
      open.startedAt += FOCUS_SEGMENT_MAX_MS;
    }
  } else if (open) {
    close(input.idle === "idle" ? (state.idleSince ?? now - IDLE_OFFSET_MS) : now);
  }
  if (!state.open && target) {
    state.open = { tabId: target.tabId, ...target.page, startedAt: now, session };
  }

  // 5. Sessions. While the gate denies events without a page, nothing changes here.
  if (input.sessionsAllowed) {
    const sess = state.sess;
    if (sess.open && sess.of !== session) {
      events.push(
        makeEvent(ids, "browser.session_ended", sess.endAt ?? now, { reason: "recovered" }),
      );
      sess.open = false;
    }
    sess.endAt = null;
    const idleFrom = input.idle === "active" ? idleBefore : state.idleSince;
    if (sess.open && idleFrom !== null && now - idleFrom >= SESSION_IDLE_TIMEOUT_MS) {
      const at = idleFrom + SESSION_IDLE_TIMEOUT_MS;
      events.push(makeEvent(ids, "browser.session_ended", at, { reason: "idle" }));
      sess.open = false;
    } else if (sess.open && input.idle === "locked") {
      events.push(makeEvent(ids, "browser.session_ended", now, { reason: "lock" }));
      sess.open = false;
    }
    if (!sess.open && input.idle === "active") {
      const reason = sess.of === session ? "resume" : "startup";
      events.push(makeEvent(ids, "browser.session_started", now, { reason }));
      sess.open = true;
      sess.of = session;
    }
  }

  state.alive = { at: now, session };
  return { state, events };
}

/**
 * Emits a visit for a completed page that was never recorded (its event was lost with a killed
 * background), with the time of the reconciliation. Marks newer than the listing win; marks from
 * another browser session and of tabs that are gone are dropped.
 */
function reconcile(
  state: EngineState,
  listing: NonNullable<FocusStepInput["reconcile"]>,
  input: FocusStepInput,
  events: CapturedEvent[],
  ids: Ids,
): void {
  const { now, session, allowed } = input;
  for (const { tabId, page } of listing.pages) {
    const key = pageKey(page);
    if (!allowed.has(key)) continue;
    const mark = currentMark(state, tabId, session);
    if (mark && (mark.page === key || mark.at > listing.at)) continue;
    const ref = mark?.ref ?? ids.newTabRef();
    events.push(makeEvent(ids, "browser.page_visited", now, { ...page, tabRef: ref }));
    state.tabs[String(tabId)] = { ref, session, page: key, recovered: true, at: listing.at };
  }
  const alive = new Set(listing.tabIds.map(String));
  for (const [id, mark] of Object.entries(state.tabs)) {
    if (mark.session !== session || (!alive.has(id) && mark.at <= listing.at)) {
      delete state.tabs[id];
    }
  }
}
