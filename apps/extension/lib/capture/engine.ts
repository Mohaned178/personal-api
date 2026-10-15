// M2-04 capture engine, async part: reads the browser, asks the rule gate, then commits one pure
// transition (state.ts) per piece of work through `CaptureStore.transact` (ADR 0002).
//
// - Capture (page_visited, tab_opened, tab_closed) commits straight from the event in its own
//   transaction; it awaits nothing but the browser-session id and the gate (option B).
// - Focus steps are serialized: browser queries, a read of the open segment, the gate, then one
//   transaction. They are level-triggered, so a missed or reordered event is corrected by the
//   next one or by the heartbeat.
// - Nothing is kept in memory but caches of persisted values. No timers, no logging. Every method
//   resolves to undefined and never rejects: a failure stores nothing (fail closed).

import { type SanitizedUrl, sanitizeUrl } from "../sanitize-url";
import { HEARTBEAT_ALARM_NAME, HEARTBEAT_PERIOD_MINUTES, IDLE_DETECTION_S } from "./constants";
import {
  captureVisit,
  type FocusStepInput,
  focusStep,
  type Ids,
  openPage,
  pageKey,
  tabClosed,
  tabOpened,
  unchanged,
} from "./state";
import type {
  CaptureDeps,
  CaptureEngine,
  CaptureIdleState,
  CaptureState,
  CaptureTab,
} from "./types";

/** `storage.session` key of the random browser-session id (cleared by a browser restart). */
const SESSION_KEY = "pa.capture.browserSession";

const IDLE_STATES: readonly unknown[] = ["active", "idle", "locked"];

const noop = (): undefined => undefined;

/** Runs `work` and settles to undefined once it settled, whatever happened. */
function settle(work: () => Promise<unknown>): Promise<void> {
  try {
    return work().then(noop, noop);
  } catch {
    return Promise.resolve();
  }
}

interface FocusOptions {
  /** The state reported by `idle.onStateChanged`, when that is the trigger. */
  idle?: CaptureIdleState;
  /** Background start: also reconcile the open tabs. */
  startup?: boolean;
}

export function createCaptureEngine(deps: CaptureDeps): CaptureEngine {
  const { browser, store } = deps;
  const ids: Ids = { newId: deps.newId, newTabRef: deps.newTabRef };

  let sessionPromise: Promise<string> | undefined;
  /** The browser-session id, created (and stored before use) by the first background of a session. */
  function browserSession(): Promise<string> {
    if (!sessionPromise) {
      const pending = (async () => {
        const stored = await browser.storage.session.get(SESSION_KEY);
        const existing = stored[SESSION_KEY];
        if (typeof existing === "string" && existing.length > 0) return existing;
        const created = deps.newId();
        await browser.storage.session.set({ [SESSION_KEY]: created });
        return created;
      })();
      sessionPromise = pending;
      pending.catch(() => {
        if (sessionPromise === pending) sessionPromise = undefined;
      });
    }
    return sessionPromise;
  }
  // Start resolving it at background start, before the first event needs it (ADR 0002 decision 3).
  browserSession().catch(noop);

  /** The rule gate: anything but exactly `true` (a throw, a rejection, any other value) denies. */
  async function allows(page: SanitizedUrl | null): Promise<boolean> {
    try {
      return (await deps.gate.allows(page)) === true;
    } catch {
      return false;
    }
  }

  // ---- capture path

  async function capture(now: number, tabId: number, tab: CaptureTab): Promise<void> {
    if (tab.incognito !== false) return;
    const session = await browserSession();
    const sanitized = sanitizeUrl(tab.url);
    const page = sanitized !== null && (await allows(sanitized)) ? sanitized : null;
    await store.transact((prev) => captureVisit(prev, { now, session, tabId, page }, ids));
  }

  async function openTab(now: number, tab: CaptureTab): Promise<void> {
    if (tab.incognito !== false || tab.id === undefined) return;
    const tabId = tab.id;
    const session = await browserSession();
    const page = sanitizeUrl(tab.url) ?? sanitizeUrl(tab.pendingUrl);
    const [emit, pageAllowed] = await Promise.all([
      allows(null),
      page === null ? false : allows(page),
    ]);
    const domain = page !== null && pageAllowed ? page.domain : null;
    await store.transact((prev) => tabOpened(prev, { now, session, tabId, domain, emit }, ids));
  }

  async function closeTab(now: number, tabId: number): Promise<void> {
    const session = await browserSession();
    const emit = await allows(null);
    await store.transact((prev) => tabClosed(prev, { now, session, tabId, emit }, ids));
  }

  // ---- focus steps

  /** The page of the active tab of the focused window, if it may be a focus segment at all. */
  async function focusedTarget(): Promise<FocusStepInput["target"]> {
    try {
      const win = await browser.windows.getLastFocused();
      if (win.focused !== true || win.incognito !== false || win.id === undefined) return null;
      const [tab] = await browser.tabs.query({ active: true, windowId: win.id });
      if (!tab || tab.id === undefined || tab.incognito !== false) return null;
      const page = sanitizeUrl(tab.url);
      return page === null ? null : { tabId: tab.id, page };
    } catch {
      return null;
    }
  }

  async function idleState(): Promise<CaptureIdleState | null> {
    try {
      const state = await browser.idle.queryState(IDLE_DETECTION_S);
      return IDLE_STATES.includes(state) ? state : null;
    } catch {
      return null;
    }
  }

  async function listTabs(): Promise<FocusStepInput["reconcile"]> {
    try {
      const at = deps.now();
      const tabs = await browser.tabs.query({});
      const tabIds: number[] = [];
      const pages: { tabId: number; page: SanitizedUrl }[] = [];
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        tabIds.push(tab.id);
        if (tab.incognito !== false || tab.status !== "complete") continue;
        const page = sanitizeUrl(tab.url);
        if (page !== null) pages.push({ tabId: tab.id, page });
      }
      return { at, tabIds, pages };
    } catch {
      return undefined;
    }
  }

  async function runFocusStep(now: number, options: FocusOptions): Promise<void> {
    const session = await browserSession();
    const [target, idle, listing] = await Promise.all([
      focusedTarget(),
      options.idle !== undefined && IDLE_STATES.includes(options.idle) ? options.idle : idleState(),
      options.startup ? listTabs() : undefined,
    ]);

    // Read the open segment, so the gate can be asked about it before it is closed.
    let snapshot: CaptureState | null = null;
    await store.transact((prev) => {
      snapshot = prev;
      return unchanged(prev);
    });

    const pages = new Map<string, SanitizedUrl>();
    const add = (page: SanitizedUrl | null | undefined): void => {
      if (page) pages.set(pageKey(page), page);
    };
    add(target?.page);
    add(openPage(snapshot));
    for (const entry of listing?.pages ?? []) add(entry.page);
    const [sessionsAllowed, ...answers] = await Promise.all([
      allows(null),
      ...[...pages.values()].map((page) => allows(page)),
    ]);
    const allowed = new Set([...pages.keys()].filter((_key, index) => answers[index] === true));

    const input: FocusStepInput = {
      now,
      session,
      target,
      idle,
      allowed,
      sessionsAllowed: sessionsAllowed === true,
    };
    if (listing) input.reconcile = listing;
    await store.transact((prev) => focusStep(prev, input, ids));
  }

  let chain: Promise<void> = Promise.resolve();
  /** Focus steps run one after another, in event order. */
  function focus(now: number, options: FocusOptions = {}): Promise<void> {
    const run = chain.then(() => runFocusStep(now, options));
    chain = run.then(noop, noop);
    return chain;
  }

  // ---- background start

  let setup: Promise<void> | undefined;
  function ensureSetup(): Promise<void> {
    setup ??= (async () => {
      browser.idle.setDetectionInterval(IDLE_DETECTION_S);
      // Recreate only when missing, so frequent restarts do not push the next tick back.
      if ((await browser.alarms.get(HEARTBEAT_ALARM_NAME)) === undefined) {
        await browser.alarms.create(HEARTBEAT_ALARM_NAME, {
          periodInMinutes: HEARTBEAT_PERIOD_MINUTES,
        });
      }
    })().catch(() => {
      setup = undefined;
    });
    return setup;
  }

  return {
    start: () =>
      settle(() => {
        const now = deps.now();
        return Promise.all([settle(ensureSetup), focus(now, { startup: true })]);
      }),
    onTabCreated: (tab) =>
      settle(() => {
        const now = deps.now();
        return openTab(now, tab);
      }),
    onTabUpdated: (tabId, changeInfo, tab) =>
      settle(() => {
        const now = deps.now();
        const work: Promise<void>[] = [];
        if (changeInfo.status === "complete") work.push(settle(() => capture(now, tabId, tab)));
        // A navigation in the focused tab ends its segment as soon as the URL or status changes.
        if (changeInfo.status !== undefined || changeInfo.url !== undefined) work.push(focus(now));
        return Promise.all(work);
      }),
    onTabActivated: () => settle(() => focus(deps.now())),
    onTabRemoved: (tabId) =>
      settle(() => {
        const now = deps.now();
        return Promise.all([settle(() => closeTab(now, tabId)), focus(now)]);
      }),
    onWindowFocusChanged: () => settle(() => focus(deps.now())),
    onIdleStateChanged: (state) => settle(() => focus(deps.now(), { idle: state })),
    onHeartbeat: () => settle(() => focus(deps.now())),
  };
}
