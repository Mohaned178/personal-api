// Test harness for the M2-04 capture engine: a world-model fake of `browser.*`, an in-memory
// durable store and a Sim that drives them. The tests mutate the WORLD (focused window, active tab,
// idle state) and then deliver the matching browser event, so the engine's level-triggered view
// (ADR 0002 decision 4) always agrees with the event, unless a test deliberately drops one.
//
// Nothing here uses real timers: time is vitest's fake `Date.now()`, moved only by `advance`.

import { type KnownEvent, parseEvent } from "@personal-api/contracts";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  type CaptureBrowserApi,
  type CaptureDeps,
  type CaptureEngine,
  type CaptureEventSource,
  type CaptureGate,
  type CaptureIdleState,
  type CaptureListenerApi,
  type CaptureState,
  type CaptureStore,
  type CaptureTab,
  type CaptureTabChangeInfo,
  type CaptureTransition,
  createCaptureEngine,
  HEARTBEAT_ALARM_NAME,
  registerCaptureListeners,
  WINDOW_ID_NONE,
} from "../../../lib/capture";

export const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const iso = (ms: number): string => new Date(ms).toISOString();

// --------------------------------------------------------------------------------------------
// clock and lifecycle

/** Elapsed fake milliseconds since T0. */
export const elapsed = (): number => Date.now() - T0;

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Lets every pending promise continuation run (no timers involved). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

const created: Sim[] = [];

/**
 * Registers the per-test hooks: fake timers with the clock at T0, every Sim made by `newSim` is
 * checked against the contracts at the end, and the engine must have scheduled no timer at all
 * (CLAUDE.md: alarms, never setTimeout/setInterval).
 */
export function setupSimTests(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    try {
      for (const sim of created.splice(0)) assertQueueValid(sim);
      expect(vi.getTimerCount(), "the engine must not schedule timers").toBe(0);
    } finally {
      created.length = 0;
      vi.useRealTimers();
    }
  });
}

export function newSim(options: SimOptions = {}): Sim {
  const sim = new Sim(options);
  created.push(sim);
  return sim;
}

/** Every queued event is a valid contracts envelope, ids are unique, paths have no `?` or `#`. */
export function assertQueueValid(sim: Sim): void {
  const ids = new Set<string>();
  for (const event of sim.queue) {
    const parsed = parseEvent(event);
    expect(parsed.ok, `event ${event.type} must satisfy the contracts`).toBe(true);
    expect(ids.has(event.id), "event ids must be unique").toBe(false);
    ids.add(event.id);
    const path = (event.data as Record<string, unknown>).path;
    if (typeof path === "string") expect(path).not.toMatch(/[?#]/);
  }
}

// --------------------------------------------------------------------------------------------
// durable store fake (what M2-05 implements over IndexedDB)

export class FakeCaptureStore implements CaptureStore {
  state: CaptureState | null = null;
  queue: KnownEvent[] = [];
  /** Transactions that started (committed or not). */
  attempts = 0;
  /** Transactions that committed. */
  commits = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private failTypes: string[] = [];
  private hold: Promise<void> | null = null;

  /** The next `n` commits abort after `compute` ran: nothing is stored (a worker killed mid-write). */
  failNextCommits(n = 1): void {
    this.failures += n;
  }

  /** The next commit that would append an event of this type aborts (others go through). */
  failNextCommitWithEvent(type: string): void {
    this.failTypes.push(type);
  }

  /** Commits wait until the returned function is called. */
  holdCommits(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hold = gate;
    return () => {
      this.hold = null;
      release();
    };
  }

  /** Everything persisted, serialized: state and queue. */
  dump(): string {
    return JSON.stringify({ state: this.state, queue: this.queue });
  }

  transact(compute: (prev: CaptureState | null) => CaptureTransition): Promise<void> {
    const run = this.tail.then(() => this.run(compute));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(compute: (prev: CaptureState | null) => CaptureTransition): Promise<void> {
    this.attempts++;
    const hold = this.hold;
    if (hold) await hold;
    const prev = this.state === null ? null : structuredClone(this.state);
    const next = compute(prev);
    if (typeof (next as unknown as { then?: unknown })?.then === "function") {
      throw new Error("compute must be synchronous (no await inside a transaction)");
    }
    // structuredClone also proves the state and events are plain, cloneable data.
    const state = structuredClone(next.state);
    const events = structuredClone(next.events);
    if (this.failures > 0) {
      this.failures--;
      throw new Error("transaction aborted");
    }
    const present = new Set<string>(events.map((e) => e.type));
    const failType = this.failTypes.find((type) => present.has(type));
    const failIndex = failType === undefined ? -1 : this.failTypes.indexOf(failType);
    if (failIndex >= 0) {
      this.failTypes.splice(failIndex, 1);
      throw new Error("transaction aborted");
    }
    this.state = state;
    this.queue.push(...events);
    this.commits++;
  }
}

// --------------------------------------------------------------------------------------------
// browser world fake

export interface WorldWindow {
  id: number;
  focused: boolean;
  incognito: unknown;
}

export interface WorldTab {
  id: number;
  windowId: number;
  url: string | undefined;
  status: "loading" | "complete";
  active: boolean;
  incognito: unknown;
}

export class FakeBrowser {
  windows = new Map<number, WorldWindow>();
  tabs = new Map<number, WorldTab>();
  lastFocusedWindowId: number | undefined;
  idleState: CaptureIdleState = "active";
  sessionStorage: Record<string, unknown> = {};
  alarms = new Map<string, { periodInMinutes: number }>();
  alarmCreates: { name: string; periodInMinutes: number }[] = [];
  detectionIntervals: number[] = [];
  queryStateArgs: number[] = [];
  fail = { getLastFocused: false, tabsQuery: false, queryState: false };
  /** Every query (getLastFocused, tabs.query, idle.queryState) never settles. */
  hang = false;
  /** Every query takes this long (the fake clock moves while it runs). */
  queryDelayMs = 0;
  nextTabId = 1;
  nextWindowId = 1;

  constructor(readonly firefox: boolean) {}

  readonly api: CaptureBrowserApi = {
    windows: {
      getLastFocused: () =>
        this.query("getLastFocused", () => {
          const win =
            this.lastFocusedWindowId === undefined
              ? undefined
              : this.windows.get(this.lastFocusedWindowId);
          if (!win) throw new Error("No last focused window");
          return { id: win.id, focused: win.focused, incognito: win.incognito as boolean };
        }),
    },
    tabs: {
      query: (queryInfo) =>
        this.query("tabsQuery", () =>
          [...this.tabs.values()]
            .filter(
              (tab) =>
                (queryInfo.active === undefined || tab.active === queryInfo.active) &&
                (queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId),
            )
            .map((tab) => this.snapshot(tab)),
        ),
    },
    idle: {
      queryState: (seconds) => {
        this.queryStateArgs.push(seconds);
        return this.query("queryState", () => this.idleState);
      },
      setDetectionInterval: (seconds) => {
        this.detectionIntervals.push(seconds);
      },
    },
    storage: {
      session: {
        get: async (key) => (key in this.sessionStorage ? { [key]: this.sessionStorage[key] } : {}),
        set: async (items) => {
          Object.assign(this.sessionStorage, items);
        },
      },
    },
    alarms: {
      get: async (name) => (this.alarms.has(name) ? { name } : undefined),
      create: async (name, info) => {
        this.alarms.set(name, info);
        this.alarmCreates.push({ name, periodInMinutes: info.periodInMinutes });
      },
    },
  };

  private async query<T>(kind: keyof FakeBrowser["fail"], produce: () => T): Promise<T> {
    if (this.hang) return new Promise<T>(() => {});
    if (this.fail[kind]) throw new Error(`${kind} failed`);
    if (this.queryDelayMs > 0) advance(this.queryDelayMs);
    return produce();
  }

  snapshot(tab: WorldTab): CaptureTab {
    const out: CaptureTab = {
      id: tab.id,
      windowId: tab.windowId,
      status: tab.status,
      active: tab.active,
      incognito: tab.incognito as boolean,
    };
    if (tab.url !== undefined) out.url = tab.url;
    return out;
  }

  addWindow(incognito: unknown, focus: boolean): WorldWindow {
    if (focus) for (const other of this.windows.values()) other.focused = false;
    const win: WorldWindow = { id: this.nextWindowId++, focused: focus, incognito };
    this.windows.set(win.id, win);
    if (focus || this.lastFocusedWindowId === undefined) this.lastFocusedWindowId = win.id;
    return win;
  }

  addTab(
    windowId: number,
    url: string | undefined,
    active: boolean,
    incognito: unknown,
    id?: number,
  ) {
    if (active) {
      for (const other of this.tabs.values()) if (other.windowId === windowId) other.active = false;
    }
    const tab: WorldTab = {
      id: id ?? this.nextTabId++,
      windowId,
      url,
      status: "complete",
      active,
      incognito,
    };
    this.nextTabId = Math.max(this.nextTabId, tab.id + 1);
    this.tabs.set(tab.id, tab);
    return tab;
  }

  /** World-only change (no event): a missed or not yet delivered event. */
  setActive(tabId: number): void {
    const tab = this.mustTab(tabId);
    for (const other of this.tabs.values())
      if (other.windowId === tab.windowId) other.active = false;
    tab.active = true;
  }

  setUnfocusedAll(): void {
    for (const win of this.windows.values()) win.focused = false;
  }

  mustWindow(windowId: number): WorldWindow {
    const win = this.windows.get(windowId);
    if (!win) throw new Error(`no window ${windowId}`);
    return win;
  }

  mustTab(tabId: number): WorldTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    return tab;
  }
}

// --------------------------------------------------------------------------------------------
// listener-side fakes

// biome-ignore lint/suspicious/noExplicitAny: generic listener signature in a test fake
export class FakeEvent<F extends (...args: any[]) => unknown> implements CaptureEventSource<F> {
  readonly listeners: F[] = [];
  addListener(listener: F): void {
    this.listeners.push(listener);
  }
  /** Calls every listener and returns what each returned (not awaited). */
  invoke(...args: Parameters<F>): ReturnType<F>[] {
    return this.listeners.map((listener) => listener(...args) as ReturnType<F>);
  }
}

type ListenerOf<S> = S extends CaptureEventSource<infer F> ? F : never;

export class FakeBus implements CaptureListenerApi {
  tabs = {
    onCreated: new FakeEvent<ListenerOf<CaptureListenerApi["tabs"]["onCreated"]>>(),
    onUpdated: new FakeEvent<ListenerOf<CaptureListenerApi["tabs"]["onUpdated"]>>(),
    onActivated: new FakeEvent<ListenerOf<CaptureListenerApi["tabs"]["onActivated"]>>(),
    onRemoved: new FakeEvent<ListenerOf<CaptureListenerApi["tabs"]["onRemoved"]>>(),
  };
  windows = {
    onFocusChanged: new FakeEvent<ListenerOf<CaptureListenerApi["windows"]["onFocusChanged"]>>(),
  };
  idle = {
    onStateChanged: new FakeEvent<ListenerOf<CaptureListenerApi["idle"]["onStateChanged"]>>(),
  };
  alarms = { onAlarm: new FakeEvent<ListenerOf<CaptureListenerApi["alarms"]["onAlarm"]>>() };
  runtime = {
    onStartup: new FakeEvent<ListenerOf<CaptureListenerApi["runtime"]["onStartup"]>>(),
    onInstalled: new FakeEvent<ListenerOf<CaptureListenerApi["runtime"]["onInstalled"]>>(),
  };

  /** Every event source with its listener count, for registration checks. */
  all(): [string, FakeEvent<never>][] {
    return [
      ["tabs.onCreated", this.tabs.onCreated],
      ["tabs.onUpdated", this.tabs.onUpdated],
      ["tabs.onActivated", this.tabs.onActivated],
      ["tabs.onRemoved", this.tabs.onRemoved],
      ["windows.onFocusChanged", this.windows.onFocusChanged],
      ["idle.onStateChanged", this.idle.onStateChanged],
      ["alarms.onAlarm", this.alarms.onAlarm],
      ["runtime.onStartup", this.runtime.onStartup],
      ["runtime.onInstalled", this.runtime.onInstalled],
    ] as unknown as [string, FakeEvent<never>][];
  }
}

// --------------------------------------------------------------------------------------------
// gates

export const allowAll: CaptureGate = { allows: () => true };
export const denyAll: CaptureGate = { allows: () => false };

/** Pages of these domains are allowed; events without a page are allowed too. */
export const allowDomains = (domains: string[]): CaptureGate => ({
  allows: (page) => page === null || domains.includes(page.domain),
});

// --------------------------------------------------------------------------------------------
// the Sim

export interface SimOptions {
  gate?: CaptureGate;
  /** Firefox profile: `idle` never reports `locked` (ADR 0002, Firefox difference 2). */
  firefox?: boolean;
  /** Deliver browser events through the registered listeners instead of calling the engine. */
  via?: "engine" | "listeners";
  /** Override the injected clock (default: the fake `Date.now`). */
  now?: () => number;
  /** Wraps the store the engine writes to (rebuilt on every worker restart, like the background). */
  wrapStore?: (store: CaptureStore) => CaptureStore;
}

export interface SegmentView {
  domain: string;
  path: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  occurredAt: number;
}

export interface SessionView {
  kind: "started" | "ended";
  reason: string;
  at: number;
}

type AnyData = Record<string, unknown>;

export class Sim {
  readonly store = new FakeCaptureStore();
  readonly browser: FakeBrowser;
  /** Swap it to change what the rules allow, even mid-run. */
  gate: CaptureGate;
  engine!: CaptureEngine;
  bus!: FakeBus;
  readonly windowId: number;
  readonly tabId: number;
  private idCounter = 0;
  private refCounter = 0;
  private readonly via: "engine" | "listeners";
  private readonly nowFn: () => number;
  private readonly wrapStore: ((store: CaptureStore) => CaptureStore) | undefined;

  constructor(options: SimOptions = {}) {
    this.gate = options.gate ?? allowAll;
    this.via = options.via ?? "engine";
    this.nowFn = options.now ?? (() => Date.now());
    this.wrapStore = options.wrapStore;
    this.browser = new FakeBrowser(options.firefox ?? false);
    const win = this.browser.addWindow(false, true);
    const tab = this.browser.addTab(win.id, "about:blank", true, false);
    this.windowId = win.id;
    this.tabId = tab.id;
    this.buildEngine();
  }

  private deps(): CaptureDeps {
    return {
      browser: this.browser.api,
      store: this.wrapStore?.(this.store) ?? this.store,
      gate: { allows: (page) => this.gate.allows(page) },
      now: this.nowFn,
      newId: () => `0193a000-0000-7000-8000-${(++this.idCounter).toString(16).padStart(12, "0")}`,
      newTabRef: () => `tabref-${(++this.refCounter).toString(36).padStart(6, "0")}`,
    };
  }

  private buildEngine(): void {
    this.engine = createCaptureEngine(this.deps());
    this.bus = new FakeBus();
    if (this.via === "listeners") registerCaptureListeners(this.bus, this.engine);
  }

  /** A worker kill: a fresh engine over the same store and the same `storage.session`. */
  restartWorker(options: { browserSession?: boolean } = {}): void {
    if (options.browserSession) this.browser.sessionStorage = {};
    this.buildEngine();
  }

  /** The background starts (the engine's `start()`, as the entrypoint calls it). */
  async start(): Promise<void> {
    await this.engine.start();
  }

  // ---- event delivery

  readonly fire = {
    tabCreated: (tab: CaptureTab): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.tabs.onCreated.invoke(tab))
        : this.engine.onTabCreated(tab),
    tabUpdated: (tabId: number, info: CaptureTabChangeInfo, tab: CaptureTab): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.tabs.onUpdated.invoke(tabId, info, tab))
        : this.engine.onTabUpdated(tabId, info, tab),
    tabActivated: (info: { tabId: number; windowId: number }): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.tabs.onActivated.invoke(info))
        : this.engine.onTabActivated(info),
    tabRemoved: (
      tabId: number,
      info: { windowId: number; isWindowClosing: boolean },
    ): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.tabs.onRemoved.invoke(tabId, info))
        : this.engine.onTabRemoved(tabId, info),
    windowFocusChanged: (windowId: number): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.windows.onFocusChanged.invoke(windowId))
        : this.engine.onWindowFocusChanged(windowId),
    idleChanged: (state: CaptureIdleState): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.idle.onStateChanged.invoke(state))
        : this.engine.onIdleStateChanged(state),
    heartbeat: (): Promise<void> =>
      this.via === "listeners"
        ? settle(this.bus.alarms.onAlarm.invoke({ name: HEARTBEAT_ALARM_NAME }))
        : this.engine.onHeartbeat(),
  };

  // ---- user actions: they change the world, then deliver the matching event

  async openWindow(
    options: { url?: string; incognito?: unknown; focus?: boolean } = {},
  ): Promise<{ windowId: number; tabId: number }> {
    const focus = options.focus ?? true;
    const win = this.browser.addWindow(options.incognito ?? false, focus);
    const tab = this.browser.addTab(win.id, options.url, true, options.incognito ?? false);
    await this.fire.tabCreated(this.browser.snapshot(tab));
    if (focus) await this.fire.windowFocusChanged(win.id);
    return { windowId: win.id, tabId: tab.id };
  }

  async openTab(
    options: {
      windowId?: number;
      url?: string;
      active?: boolean;
      incognito?: unknown;
      id?: number;
    } = {},
  ): Promise<number> {
    const windowId = options.windowId ?? this.browser.lastFocusedWindowId ?? this.windowId;
    const win = this.browser.windows.get(windowId);
    const active = options.active ?? true;
    const tab = this.browser.addTab(
      windowId,
      options.url,
      active,
      "incognito" in options ? options.incognito : (win?.incognito ?? false),
      options.id,
    );
    await this.fire.tabCreated(this.browser.snapshot(tab));
    if (active) await this.fire.tabActivated({ tabId: tab.id, windowId });
    return tab.id;
  }

  /** A full navigation: the URL changes (loading), then the page completes. */
  async navigate(tabId: number, url: string, options: { loadMs?: number } = {}): Promise<void> {
    const tab = this.browser.mustTab(tabId);
    tab.url = url;
    tab.status = "loading";
    await this.fire.tabUpdated(tabId, { url, status: "loading" }, this.browser.snapshot(tab));
    if (options.loadMs) advance(options.loadMs);
    tab.status = "complete";
    await this.fire.tabUpdated(tabId, { status: "complete" }, this.browser.snapshot(tab));
  }

  /** The same page loads again (reload). */
  async reload(tabId: number): Promise<void> {
    const tab = this.browser.mustTab(tabId);
    tab.status = "loading";
    await this.fire.tabUpdated(tabId, { status: "loading" }, this.browser.snapshot(tab));
    tab.status = "complete";
    await this.fire.tabUpdated(tabId, { status: "complete" }, this.browser.snapshot(tab));
  }

  /** Delivers an arbitrary `onUpdated` for the tab's current world state. */
  update(tabId: number, changeInfo: Record<string, unknown>): Promise<void> {
    const tab = this.browser.mustTab(tabId);
    return this.fire.tabUpdated(
      tabId,
      changeInfo as CaptureTabChangeInfo,
      this.browser.snapshot(tab),
    );
  }

  async activate(tabId: number): Promise<void> {
    this.browser.setActive(tabId);
    await this.fire.tabActivated({ tabId, windowId: this.browser.mustTab(tabId).windowId });
  }

  async focusWindow(windowId: number): Promise<void> {
    for (const win of this.browser.windows.values()) win.focused = win.id === windowId;
    this.browser.lastFocusedWindowId = windowId;
    await this.fire.windowFocusChanged(windowId);
  }

  /** Focus leaves the browser (another application, minimize): `WINDOW_ID_NONE`. */
  async blur(): Promise<void> {
    this.browser.setUnfocusedAll();
    await this.fire.windowFocusChanged(WINDOW_ID_NONE);
  }

  async setIdle(state: CaptureIdleState): Promise<void> {
    if (this.browser.firefox && state === "locked") {
      throw new Error("Firefox never reports the locked state");
    }
    this.browser.idleState = state;
    await this.fire.idleChanged(state);
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.browser.tabs.get(tabId);
    if (!tab) {
      await this.fire.tabRemoved(tabId, { windowId: this.windowId, isWindowClosing: false });
      return;
    }
    this.browser.tabs.delete(tabId);
    let neighbor: WorldTab | undefined;
    if (tab.active) {
      neighbor = [...this.browser.tabs.values()]
        .filter((other) => other.windowId === tab.windowId)
        .sort((a, b) => a.id - b.id)[0];
      if (neighbor) neighbor.active = true;
    }
    await this.fire.tabRemoved(tabId, { windowId: tab.windowId, isWindowClosing: false });
    if (neighbor) await this.fire.tabActivated({ tabId: neighbor.id, windowId: tab.windowId });
  }

  heartbeat(): Promise<void> {
    return this.fire.heartbeat();
  }

  /** Advances the clock and fires one heartbeat, `times` times. */
  async beats(times: number, everyMs = 30 * SECOND): Promise<void> {
    for (let i = 0; i < times; i++) {
      advance(everyMs);
      await this.heartbeat();
    }
  }

  // ---- reading what was queued

  get queue(): KnownEvent[] {
    return this.store.queue;
  }

  ofType(type: string): KnownEvent[] {
    return this.queue.filter((event) => event.type === type);
  }

  data(type: string): AnyData[] {
    return this.ofType(type).map((event) => event.data as AnyData);
  }

  visits(): { domain: string; path: string; tabRef: string; occurredAt: number }[] {
    return this.ofType("browser.page_visited").map((event) => ({
      ...(event.data as { domain: string; path: string; tabRef: string }),
      occurredAt: Date.parse(event.occurredAt),
    }));
  }

  segments(): SegmentView[] {
    return this.ofType("browser.focus_segment")
      .map((event) => {
        const data = event.data as {
          domain: string;
          path: string;
          startedAt: string;
          endedAt: string;
          durationMs: number;
        };
        return {
          domain: data.domain,
          path: data.path,
          startedAt: Date.parse(data.startedAt),
          endedAt: Date.parse(data.endedAt),
          durationMs: data.durationMs,
          occurredAt: Date.parse(event.occurredAt),
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  sessionEvents(): SessionView[] {
    return this.queue.flatMap((event) => {
      if (event.type !== "browser.session_started" && event.type !== "browser.session_ended") {
        return [];
      }
      return [
        {
          kind:
            event.type === "browser.session_started" ? ("started" as const) : ("ended" as const),
          reason: (event.data as { reason: string }).reason,
          at: Date.parse(event.occurredAt),
        },
      ];
    });
  }
}

/** Resolves when every listener result settled; listener results are promises or undefined. */
async function settle(results: unknown[]): Promise<void> {
  await Promise.all(results);
}

/** Segment as [start, end] offsets from T0, for compact expectations. */
export const span = (s: SegmentView): [number, number] => [s.startedAt - T0, s.endedAt - T0];
