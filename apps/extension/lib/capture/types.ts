// M2-04 capture engine: the injected dependencies and the public surface.
//
// The engine is created once per background start (service worker on Edge, event page on
// Firefox) and holds NO state of its own between calls: everything that must survive a kill lives
// behind `CaptureStore` (ADR 0002 decisions 1 and 2). Tests build a second engine over the same
// store and the same `storage.session` to simulate a worker kill.

import type { KnownEvent } from "@personal-api/contracts";
import type { SanitizedUrl } from "../sanitize-url";

/** An event exactly as the queue will send it: a contracts envelope (`parseEvent(e).ok`), no `meta`. */
export type CapturedEvent = KnownEvent;

/** `idle.IdleState`. Firefox never reports `locked` (ADR 0002, Firefox difference 2). */
export type CaptureIdleState = "active" | "idle" | "locked";

export interface CaptureTab {
  id?: number;
  windowId?: number;
  url?: string;
  pendingUrl?: string;
  status?: string;
  active?: boolean;
  /** Anything other than the boolean `false` is treated as incognito (fail closed). */
  incognito: boolean;
}

export interface CaptureWindow {
  id?: number;
  focused: boolean;
  /** Anything other than the boolean `false` is treated as incognito (fail closed). */
  incognito: boolean;
}

export interface CaptureTabChangeInfo {
  status?: string;
  url?: string;
}

/** Opaque, structured-cloneable state record. Only the engine knows its shape. */
export type CaptureState = Record<string, unknown>;

export interface CaptureTransition {
  state: CaptureState;
  events: CapturedEvent[];
}

/**
 * The durable store: persisted state and the event queue in ONE database (ADR 0002 decision 1).
 * `transact` is the only way state and events change (ADR 0002 decision 2):
 *
 * - `compute` runs once, synchronously (it must not return a promise), on the last committed
 *   state (`null` before the first commit);
 * - the returned state replaces the stored one and the returned events are appended to the queue,
 *   all-or-nothing, and the promise resolves only after that commit;
 * - if `compute` throws, or the commit fails (worker killed), nothing changes and the promise
 *   rejects;
 * - overlapping transactions are applied one after another in call order.
 *
 * M2-05 implements this over IndexedDB; tests use an in-memory fake.
 */
export interface CaptureStore {
  transact(compute: (prev: CaptureState | null) => CaptureTransition): Promise<void>;
}

/**
 * The rule gate (deny by default, fail closed; ADR 0002 decision 8). Asked before anything that
 * carries a page is emitted or stored, on every emission path (capture, focus segments and
 * startup reconciliation).
 *
 * - `allows({ domain, path })`: may this (already sanitized) page be collected?
 * - `allows(null)`: may events that carry no page (tab_opened/closed without a domain, session
 *   events) be collected?
 *
 * Anything other than the boolean `true` (false, a throw, a rejection, any other value) is a deny.
 * Pausing capture is a gate that denies. The rules gate (lib/rules/gate.ts, M4-06) is the real one.
 */
export interface CaptureGate {
  allows(page: SanitizedUrl | null): boolean | Promise<boolean>;
}

/** The query side of `browser.*` the engine uses. WXT's real `browser` must be assignable to it. */
export interface CaptureBrowserApi {
  windows: { getLastFocused(): Promise<CaptureWindow> };
  tabs: { query(queryInfo: { active?: boolean; windowId?: number }): Promise<CaptureTab[]> };
  idle: {
    queryState(detectionIntervalInSeconds: number): Promise<CaptureIdleState>;
    setDetectionInterval(intervalInSeconds: number): void;
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  alarms: {
    get(name: string): Promise<{ name: string } | undefined>;
    create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void> | void;
  };
}

export interface CaptureDeps {
  browser: CaptureBrowserApi;
  store: CaptureStore;
  gate: CaptureGate;
  /** Epoch milliseconds. Read when an engine method is entered (the event time). */
  now: () => number;
  /** RFC 9562 UUID for an event id (v7 in production). */
  newId: () => string;
  /** Random per-browser-session tab reference, 8 to 64 URL-safe characters (contracts' tabRefSchema). */
  newTabRef: () => string;
}

/**
 * Every method resolves (to `undefined`, never to a value) once the work it started has
 * committed or failed, and NEVER rejects: a failure is swallowed (fail closed, nothing stored).
 * Listeners return these promises (ADR 0002, Firefox difference 1).
 */
export interface CaptureEngine {
  /** Every background start: recover after a kill or restart, reconcile open tabs, set up the heartbeat. Idempotent. */
  start(): Promise<void>;
  onTabCreated(tab: CaptureTab): Promise<void>;
  onTabUpdated(tabId: number, changeInfo: CaptureTabChangeInfo, tab: CaptureTab): Promise<void>;
  onTabActivated(activeInfo: { tabId: number; windowId: number }): Promise<void>;
  onTabRemoved(
    tabId: number,
    removeInfo: { windowId: number; isWindowClosing: boolean },
  ): Promise<void>;
  onWindowFocusChanged(windowId: number): Promise<void>;
  onIdleStateChanged(state: CaptureIdleState): Promise<void>;
  /** The heartbeat alarm fired. */
  onHeartbeat(): Promise<void>;
}

/** The listener side of `browser.*` used by `registerCaptureListeners`. */
export interface CaptureEventSource<F> {
  addListener(listener: F): void;
}

/** What a captured-event listener returns: the engine's work promise, or nothing. */
export type CaptureListenerResult = Promise<void> | undefined;

export interface CaptureListenerApi {
  tabs: {
    onCreated: CaptureEventSource<(tab: CaptureTab) => CaptureListenerResult>;
    onUpdated: CaptureEventSource<
      (tabId: number, changeInfo: CaptureTabChangeInfo, tab: CaptureTab) => CaptureListenerResult
    >;
    onActivated: CaptureEventSource<
      (activeInfo: { tabId: number; windowId: number }) => CaptureListenerResult
    >;
    onRemoved: CaptureEventSource<
      (
        tabId: number,
        removeInfo: { windowId: number; isWindowClosing: boolean },
      ) => CaptureListenerResult
    >;
  };
  windows: {
    onFocusChanged: CaptureEventSource<(windowId: number) => CaptureListenerResult>;
  };
  idle: {
    onStateChanged: CaptureEventSource<(state: CaptureIdleState) => CaptureListenerResult>;
  };
  alarms: {
    onAlarm: CaptureEventSource<(alarm: { name: string }) => CaptureListenerResult>;
  };
  runtime: {
    onStartup: CaptureEventSource<() => CaptureListenerResult>;
    onInstalled: CaptureEventSource<(details?: unknown) => CaptureListenerResult>;
  };
}
