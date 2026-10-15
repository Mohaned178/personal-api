import { describe, expect, it, vi } from "vitest";
import {
  type CaptureEngine,
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_PERIOD_MINUTES,
  IDLE_DETECTION_S,
  registerCaptureListeners,
  WINDOW_ID_NONE,
} from "../../lib/capture";
import { advance, FakeBus, flush, newSim, setupSimTests } from "./support/sim";

// M2-04: listener registration (CLAUDE.md: register every listener at top level, synchronously)
// and the Firefox requirement of ADR 0002 ("every listener returns the promise of its work").

setupSimTests();

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
}

function stubEngine() {
  const pending: Deferred[] = [];
  const next = (..._args: unknown[]) => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    pending.push({ promise, resolve });
    return promise as Promise<void>;
  };
  const engine = {
    start: vi.fn(next),
    onTabCreated: vi.fn(next),
    onTabUpdated: vi.fn(next),
    onTabActivated: vi.fn(next),
    onTabRemoved: vi.fn(next),
    onWindowFocusChanged: vi.fn(next),
    onIdleStateChanged: vi.fn(next),
    onHeartbeat: vi.fn(next),
  } satisfies CaptureEngine;
  return { engine, pending };
}

const TAB = { id: 5, windowId: 1, url: "https://a.test/x", status: "complete", incognito: false };

describe("registerCaptureListeners", () => {
  it("registers every listener synchronously, exactly once, and returns nothing", () => {
    const bus = new FakeBus();
    const { engine } = stubEngine();
    const result = registerCaptureListeners(bus, engine);
    expect(result).toBeUndefined();
    // No await happened: everything is registered in the same turn (Chrome only wakes a stopped
    // worker for listeners added during the first turn of the script).
    for (const [name, source] of bus.all()) {
      expect(source.listeners, name).toHaveLength(1);
    }
  });

  it("forwards each event's arguments to the matching engine method", () => {
    const bus = new FakeBus();
    const { engine } = stubEngine();
    registerCaptureListeners(bus, engine);

    bus.tabs.onCreated.invoke(TAB);
    expect(engine.onTabCreated).toHaveBeenCalledWith(TAB);

    const changeInfo = { status: "complete" };
    bus.tabs.onUpdated.invoke(5, changeInfo, TAB);
    expect(engine.onTabUpdated).toHaveBeenCalledWith(5, changeInfo, TAB);

    bus.tabs.onActivated.invoke({ tabId: 5, windowId: 1 });
    expect(engine.onTabActivated).toHaveBeenCalledWith({ tabId: 5, windowId: 1 });

    bus.tabs.onRemoved.invoke(5, { windowId: 1, isWindowClosing: false });
    expect(engine.onTabRemoved).toHaveBeenCalledWith(5, { windowId: 1, isWindowClosing: false });

    bus.windows.onFocusChanged.invoke(WINDOW_ID_NONE);
    expect(engine.onWindowFocusChanged).toHaveBeenCalledWith(WINDOW_ID_NONE);

    bus.idle.onStateChanged.invoke("locked");
    expect(engine.onIdleStateChanged).toHaveBeenCalledWith("locked");
  });

  it("runs the heartbeat only for the heartbeat alarm", () => {
    const bus = new FakeBus();
    const { engine } = stubEngine();
    registerCaptureListeners(bus, engine);
    bus.alarms.onAlarm.invoke({ name: "some-other-alarm" });
    expect(engine.onHeartbeat).not.toHaveBeenCalled();
    bus.alarms.onAlarm.invoke({ name: HEARTBEAT_ALARM_NAME });
    expect(engine.onHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("keeps the (otherwise empty) onStartup and onInstalled listeners so Firefox starts the event page at browser start", () => {
    const bus = new FakeBus();
    const { engine } = stubEngine();
    registerCaptureListeners(bus, engine);
    expect(bus.runtime.onStartup.listeners).toHaveLength(1);
    expect(bus.runtime.onInstalled.listeners).toHaveLength(1);
    for (const result of [...bus.runtime.onStartup.invoke(), ...bus.runtime.onInstalled.invoke()]) {
      expect(result === undefined || result instanceof Promise).toBe(true);
    }
  });

  it("returns the engine's work promise from every event listener and settles with it, to undefined", async () => {
    const bus = new FakeBus();
    const { engine, pending } = stubEngine();
    registerCaptureListeners(bus, engine);

    const calls: [string, () => unknown[]][] = [
      ["tabs.onCreated", () => bus.tabs.onCreated.invoke(TAB)],
      ["tabs.onUpdated", () => bus.tabs.onUpdated.invoke(5, { status: "complete" }, TAB)],
      ["tabs.onActivated", () => bus.tabs.onActivated.invoke({ tabId: 5, windowId: 1 })],
      [
        "tabs.onRemoved",
        () => bus.tabs.onRemoved.invoke(5, { windowId: 1, isWindowClosing: false }),
      ],
      ["windows.onFocusChanged", () => bus.windows.onFocusChanged.invoke(1)],
      ["idle.onStateChanged", () => bus.idle.onStateChanged.invoke("idle")],
      ["alarms.onAlarm", () => bus.alarms.onAlarm.invoke({ name: HEARTBEAT_ALARM_NAME })],
    ];
    for (const [name, call] of calls) {
      const before = pending.length;
      const [returned] = call();
      expect(returned, `${name} must return a promise`).toBeInstanceOf(Promise);
      let settled = false;
      let value: unknown = "not settled";
      void (returned as Promise<unknown>).then((v) => {
        settled = true;
        value = v;
      });
      await flush();
      expect(settled, `${name} must stay pending while the engine's work is pending`).toBe(false);
      pending[before]?.resolve({ notCloneable: "value" });
      await flush();
      expect(settled, `${name} must settle once the work settled`).toBe(true);
      // Firefox structured-clones what a listener's promise resolves to: it must be undefined.
      expect(value, `${name} must resolve to undefined`).toBeUndefined();
    }
  });
});

describe("listeners wired to a real engine", () => {
  it("returns a promise that stays pending until the commit lands, then settles to undefined", async () => {
    const sim = newSim({ via: "listeners" });
    await sim.start();
    sim.browser.mustTab(sim.tabId).url = "https://a.test/held";
    const release = sim.store.holdCommits();
    const returned = sim.update(sim.tabId, { status: "complete" });
    let settled = false;
    void returned.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    release();
    await expect(returned).resolves.toBeUndefined();
    expect(sim.visits().map((v) => v.path)).toEqual(["/held"]);
  });

  it("captures a visit, a segment and a tab event through the registered listeners", async () => {
    const sim = newSim({ via: "listeners" });
    await sim.start();
    const tabId = await sim.openTab();
    await sim.navigate(tabId, "https://a.test/p?x=1");
    advance(4000);
    await sim.blur();
    await sim.closeTab(tabId);
    expect(sim.visits().map((v) => v.path)).toEqual(["/p"]);
    expect(sim.segments().map((s) => s.durationMs)).toEqual([4000]);
    expect(sim.ofType("browser.tab_opened")).toHaveLength(1);
    expect(sim.ofType("browser.tab_closed")).toHaveLength(1);
  });

  it("settles to undefined even when the commit fails", async () => {
    const sim = newSim({ via: "listeners" });
    await sim.start();
    sim.browser.mustTab(sim.tabId).url = "https://a.test/x";
    sim.store.failNextCommitWithEvent("browser.page_visited");
    await expect(sim.update(sim.tabId, { status: "complete" })).resolves.toBeUndefined();
    expect(sim.ofType("browser.page_visited")).toEqual([]);
  });
});

describe("engine.start()", () => {
  it("sets the idle detection interval to 60 s and creates the 30 s heartbeat alarm when it is missing", async () => {
    const sim = newSim();
    await sim.start();
    expect(sim.browser.detectionIntervals).toEqual([IDLE_DETECTION_S]);
    expect(sim.browser.alarmCreates).toEqual([
      { name: HEARTBEAT_ALARM_NAME, periodInMinutes: HEARTBEAT_PERIOD_MINUTES },
    ]);
  });

  it("does not recreate an alarm that already exists, so frequent restarts do not push the next tick back", async () => {
    const sim = newSim();
    await sim.start();
    sim.restartWorker();
    await sim.start();
    sim.restartWorker();
    await sim.start();
    expect(sim.browser.alarmCreates).toHaveLength(1);
  });

  it("never schedules a timer: the only clock is the alarm", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/x");
    await sim.beats(3);
    await sim.blur();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves to undefined even when the browser APIs it needs fail", async () => {
    const sim = newSim();
    sim.browser.fail.getLastFocused = true;
    sim.browser.fail.tabsQuery = true;
    sim.browser.fail.queryState = true;
    await expect(sim.start()).resolves.toBeUndefined();
  });
});
