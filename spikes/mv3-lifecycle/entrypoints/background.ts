// THROWAWAY Spike A (M0-10) prototype. Contract with the e2e tests: apps/e2e/support/spike.ts.
// Findings and the resulting design: docs/adr/0002-mv3-state-persistence.md.
//
// The MV3 service worker can be stopped at any moment, so:
//   - every listener is registered synchronously at top level (Chrome only wakes a stopped worker
//     for listeners registered during the first turn of the script);
//   - nothing lives in memory between events: every transition reads the persisted state, computes
//     and commits state + new events in ONE IndexedDB transaction before it resolves;
//   - a completed navigation is captured straight from the listener in its own transaction, so it
//     is durable within milliseconds; focus steps (which need async chrome queries first) are
//     serialized behind each other and may lag without delaying capture;
//   - on every worker start, open tabs are reconciled against the per-tab marks to recover a visit
//     whose event was delivered to a worker that died before committing it;
//   - the only timer is a chrome.alarms heartbeat, never setTimeout/setInterval. A persisted,
//     manual-protocol-only switch (`__spike.setHeartbeat`) can turn it off, so idle, lock and
//     focus events can be checked against a stopped worker.
//
// Privacy: only domain + path of http(s) pages reach storage (lib/core.ts reduceUrl), incognito
// tabs are ignored, titles are never read, and nothing about pages is logged.

import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  capture,
  cleared,
  type FocusSegmentEvent,
  HEARTBEAT_PERIOD_MIN,
  IDLE_DETECTION_S,
  type IdleState,
  type QueuedEvent,
  step,
  type TabInfo,
} from "../lib/core";
import { openDb, readQueue, readState, transact } from "../lib/db";
import { HEARTBEAT_FLAG_KEY, heartbeatAlarmAction, isHeartbeatEnabled } from "../lib/heartbeat";

const HEARTBEAT_ALARM = "spike-heartbeat";
/** Random id of the current browser session, kept in chrome.storage.session (cleared on restart). */
const SESSION_KEY = "spikeBrowserSession";

const newId = (): string => crypto.randomUUID();

let sessionPromise: Promise<string> | undefined;
/**
 * The browser session id, created by the first worker of a session. It is written before it is
 * used, so a worker killed half-way never leaves state tagged with an id nobody stored.
 */
function browserSession(): Promise<string> {
  sessionPromise ??= (async () => {
    const stored = await browser.storage.session.get(SESSION_KEY);
    const existing = stored[SESSION_KEY];
    if (typeof existing === "string") return existing;
    const created = newId();
    await browser.storage.session.set({ [SESSION_KEY]: created });
    return created;
  })();
  sessionPromise.catch(() => {
    sessionPromise = undefined;
  });
  return sessionPromise;
}

const warn = (what: string) => (error: unknown) => {
  // Fail closed: nothing was committed. Never log URLs or payloads, only the error class.
  console.warn(`spike: ${what} failed`, error instanceof Error ? error.name : typeof error);
};

function captureVisit(tab: TabInfo): void {
  const now = Date.now();
  browserSession()
    .then((session) => transact((prev) => capture(prev, { now, session, tab }, newId)))
    .catch(warn("capture"));
}

async function focusedTab(): Promise<TabInfo | null> {
  try {
    const win = await browser.windows.getLastFocused();
    // `focused` is false when focus moved to another application (WINDOW_ID_NONE).
    if (!win.focused || win.id === undefined) return null;
    const [tab] = await browser.tabs.query({ active: true, windowId: win.id });
    if (!tab || tab.id === undefined) return null;
    return { tabId: tab.id, url: tab.url, incognito: tab.incognito };
  } catch {
    // No window at all (browser closing). No focus means no open segment: the safe direction.
    return null;
  }
}

async function idleState(): Promise<IdleState> {
  try {
    return await browser.idle.queryState(IDLE_DETECTION_S);
  } catch {
    return "locked";
  }
}

async function allTabs(): Promise<TabInfo[]> {
  const tabs = await browser.tabs.query({});
  return tabs.flatMap((tab) =>
    tab.id === undefined
      ? []
      : [{ tabId: tab.id, url: tab.url, incognito: tab.incognito, status: tab.status }],
  );
}

interface FocusTrigger {
  /** Worker start: also reconcile every open tab against the persisted tab marks. */
  startup?: boolean;
  /** The state reported by chrome.idle.onStateChanged, when that is the trigger. */
  idle?: IdleState;
}

// Serializes focus steps inside this worker, so their snapshots are applied in event order.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

function focusStep(trigger: FocusTrigger): void {
  const now = Date.now();
  serial(async () => {
    const session = await browserSession();
    const listedAt = Date.now();
    const [focused, idle, tabs] = await Promise.all([
      focusedTab(),
      trigger.idle ?? idleState(),
      trigger.startup ? allTabs() : Promise.resolve(undefined),
    ]);
    const openTabs = tabs && { tabs, at: listedAt };
    await transact((prev) => step(prev, { now, session, focused, idle, openTabs }, newId));
  }).catch(warn("focus step"));
}

async function readHeartbeatFlag(): Promise<boolean> {
  const stored = await browser.storage.local.get(HEARTBEAT_FLAG_KEY);
  return isHeartbeatEnabled(stored[HEARTBEAT_FLAG_KEY]);
}

async function syncHeartbeatAlarm(): Promise<void> {
  // Alarms usually survive worker restarts but may be cleared on browser restart: recreate only
  // when missing, so frequent worker restarts do not keep pushing the next tick back. The manual
  // protocol's switch (persisted, so it holds across worker restarts) clears it instead.
  const enabled = await readHeartbeatFlag();
  const exists = (await browser.alarms.get(HEARTBEAT_ALARM)) !== undefined;
  const action = heartbeatAlarmAction(enabled, exists);
  if (action === "create") {
    await browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
  } else if (action === "clear") {
    await browser.alarms.clear(HEARTBEAT_ALARM);
  }
}

// Serializes the worker-start sync and switch changes, so a sync that read the old flag cannot
// recreate the alarm after a switch-off cleared it.
let heartbeatChain: Promise<unknown> = Promise.resolve();
function heartbeatTask(task: () => Promise<void>): Promise<void> {
  const run = heartbeatChain.then(task, task);
  heartbeatChain = run.catch(() => {});
  return run;
}

const ensureHeartbeat = (): Promise<void> => heartbeatTask(syncHeartbeatAlarm);

/** Manual protocol only: persists the switch, then creates or clears the alarm to match. */
const setHeartbeat = (enabled: boolean): Promise<void> => {
  if (typeof enabled !== "boolean") {
    return Promise.reject(new TypeError("setHeartbeat expects true or false"));
  }
  return heartbeatTask(async () => {
    await browser.storage.local.set({ [HEARTBEAT_FLAG_KEY]: enabled });
    await syncHeartbeatAlarm();
  });
};

const isSegment = (event: QueuedEvent): event is FocusSegmentEvent =>
  event.type === "focus_segment";

export default defineBackground(() => {
  // Start opening the database and resolving the session before the first event is handled.
  openDb().catch(warn("open database"));
  browserSession().catch(warn("session"));
  browser.idle.setDetectionInterval(IDLE_DETECTION_S);

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
      captureVisit({ tabId, url: tab.url, incognito: tab.incognito });
    }
    // A navigation in the focused tab closes its segment as soon as the URL changes.
    if (changeInfo.status === "complete" || changeInfo.url !== undefined) focusStep({});
  });
  browser.tabs.onActivated.addListener(() => focusStep({}));
  browser.tabs.onRemoved.addListener(() => focusStep({}));
  browser.windows.onFocusChanged.addListener(() => focusStep({}));
  browser.idle.onStateChanged.addListener((state) => focusStep({ idle: state }));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) focusStep({});
  });
  // These two only make Chrome start the worker at browser start / install; the startup step
  // below runs on every worker start anyway.
  browser.runtime.onStartup.addListener(() => {});
  browser.runtime.onInstalled.addListener(() => {});

  // Every worker start: recover what a kill or a browser restart may have interrupted.
  focusStep({ startup: true });
  ensureHeartbeat().catch(warn("heartbeat alarm"));

  (globalThis as { __spike?: unknown }).__spike = {
    bootId: newId(),
    queueDump: () => readQueue(),
    segments: async () =>
      (await readQueue())
        .filter(isSegment)
        .map(({ domain, path, startedAt, endedAt, durationMs }) => ({
          domain,
          path,
          startedAt,
          endedAt,
          durationMs,
        }))
        .sort((a, b) => a.startedAt - b.startedAt),
    clear: () => serial(() => transact(cleared, { clearQueue: true })),
    /** Not part of the test contract: counters quoted in the ADR. */
    diagnostics: async () => (await readState()).diag,
    /** Not part of the test contract: manual-protocol switch for the heartbeat alarm (M1-M3). */
    setHeartbeat,
    heartbeatEnabled: readHeartbeatFlag,
  };
});
