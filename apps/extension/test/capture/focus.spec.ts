import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { advance, MINUTE, newSim, SECOND, setupSimTests, span, T0 } from "./support/sim";

// M2-04: the focus_segment state machine (PLAN §4, ADR 0002 decisions 4, 5 and 6). Level-triggered:
// each step looks at the focused window, its active tab and the idle state, and diffs that with
// the persisted open segment. Idle ends a segment at (event time - 60 s), lock and blur at the
// event time, nothing is longer than 30 minutes, zero-length segments are not emitted.

setupSimTests();

const A = "https://a.test/a";
const B = "https://b.test/b";

const view = (sim: ReturnType<typeof newSim>) =>
  sim.segments().map((s) => [s.domain + s.path, ...span(s)]);

describe("focus segments: start and stop", () => {
  it("closes a segment on window blur at the event time and starts a new one when focus returns", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(5000);
    await sim.blur();
    advance(20_000);
    await sim.focusWindow(sim.windowId);
    advance(3000);
    await sim.navigate(sim.tabId, B);
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 5000],
      ["a.test/a", 25_000, 28_000],
    ]);
  });

  it("ends a tab's segment exactly where the next tab's segment starts on a tab switch", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(3000);
    const second = await sim.openTab();
    await sim.navigate(second, B);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 3000],
      ["b.test/b", 3000, 5000],
    ]);
  });

  it("switches back to an earlier tab with back-to-back segments", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1000);
    const second = await sim.openTab();
    await sim.navigate(second, B);
    advance(4000);
    await sim.activate(sim.tabId);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 1000],
      ["b.test/b", 1000, 5000],
      ["a.test/a", 5000, 7000],
    ]);
  });

  it("closes the segment when the same tab navigates to another page", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(500);
    await sim.navigate(sim.tabId, B);
    advance(700);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 500],
      ["b.test/b", 500, 1200],
    ]);
  });

  it("closes the segment when another window takes focus and opens one for that window's page", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(2000);
    const other = await sim.openWindow();
    await sim.navigate(other.tabId, B);
    advance(3000);
    await sim.focusWindow(sim.windowId);
    advance(1000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 2000],
      ["b.test/b", 2000, 5000],
      ["a.test/a", 5000, 6000],
    ]);
  });

  it("closes the segment when the active tab is not an http(s) page, and opens none for it", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(2000);
    const blank = await sim.openTab();
    advance(4000);
    await sim.activate(sim.tabId);
    advance(1500);
    await sim.blur();
    expect(blank).toBeGreaterThan(0);
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 2000],
      ["a.test/a", 6000, 7500],
    ]);
  });

  it("closes the segment when the focused tab is closed, and continues with the tab that becomes active", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1000);
    const second = await sim.openTab();
    await sim.navigate(second, B);
    advance(4000);
    await sim.closeTab(second);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 1000],
      ["b.test/b", 1000, 5000],
      ["a.test/a", 5000, 7000],
    ]);
  });

  it("does not split or re-open a segment while the same page stays focused", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(4); // 30 s, 60 s, 90 s, 120 s
    expect(sim.segments()).toEqual([]);
    advance(5000);
    await sim.blur();
    expect(view(sim)).toEqual([["a.test/a", 0, 125_000]]);
  });

  it("opens no segment while the window is blurred, even when the idle state returns to active", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1000);
    await sim.blur();
    await sim.setIdle("idle");
    advance(10_000);
    await sim.setIdle("active");
    advance(5000);
    await sim.heartbeat();
    expect(view(sim)).toEqual([["a.test/a", 0, 1000]]);
  });
});

describe("focus segments: idle and lock (Chromium)", () => {
  it("ends the segment at the last input on idle (event time minus 60 s) and resumes on active", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(3); // 30 s, 60 s, 90 s
    advance(10_000);
    await sim.setIdle("idle"); // reported at 100 s, last input at 40 s
    expect(view(sim)).toEqual([["a.test/a", 0, 40_000]]);
    advance(30_000);
    await sim.setIdle("active"); // 130 s
    advance(5000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 40_000],
      ["a.test/a", 130_000, 135_000],
    ]);
    expect(sim.browser.queryStateArgs.every((seconds) => seconds === 60)).toBe(true);
  });

  it("never ends an idle segment before it started, and drops the resulting zero-length segment", async () => {
    const sim = newSim();
    await sim.start();
    advance(50_000);
    await sim.navigate(sim.tabId, A); // opens at 50 s
    advance(20_000);
    await sim.setIdle("idle"); // 70 s: 70 - 60 = 10 s is before the segment started
    expect(sim.segments()).toEqual([]);
    advance(10_000);
    await sim.setIdle("active"); // 80 s
    advance(5000);
    await sim.blur();
    expect(view(sim)).toEqual([["a.test/a", 80_000, 85_000]]);
  });

  it("ends the segment at the event time on lock, and starts a new one after unlock", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1); // 30 s
    advance(15_000);
    await sim.setIdle("locked"); // 45 s: not minus 60 s
    expect(view(sim)).toEqual([["a.test/a", 0, 45_000]]);
    advance(5 * MINUTE);
    await sim.setIdle("active"); // 345 s
    advance(10_000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 45_000],
      ["a.test/a", 345_000, 355_000],
    ]);
  });

  it("does not emit a second segment when a lock follows idle", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(3);
    advance(10_000);
    await sim.setIdle("idle"); // 100 s
    advance(30_000);
    await sim.setIdle("locked"); // 130 s
    expect(view(sim)).toEqual([["a.test/a", 0, 40_000]]);
  });

  it("treats a failing idle query as not active (fail closed) and recovers afterwards", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(3000);
    sim.browser.fail.queryState = true;
    await expect(sim.heartbeat()).resolves.toBeUndefined();
    expect(view(sim)).toEqual([["a.test/a", 0, 3000]]);
    sim.browser.fail.queryState = false;
    advance(2000);
    await sim.heartbeat();
    advance(1000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 3000],
      ["a.test/a", 5000, 6000],
    ]);
  });
});

describe("focus segments: Firefox differences (Spike C, ADR 0002)", () => {
  it("has no locked state: a lock longer than 60 s shows up as idle and is not over-counted", async () => {
    const sim = newSim({ firefox: true });
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(6); // 30 s ... 180 s
    advance(20_000);
    await sim.setIdle("idle"); // 200 s: the user locked at 140 s, Firefox reports idle 60 s later
    expect(view(sim)).toEqual([["a.test/a", 0, 140_000]]);
    advance(60_000);
    await sim.setIdle("active"); // unlock and first input at 260 s
    advance(4000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 140_000],
      ["a.test/a", 260_000, 264_000],
    ]);
    expect(sim.browser.queryStateArgs.every((seconds) => seconds === 60)).toBe(true);
  });

  it("closes the segment at the blur when the OS takes focus away on lock", async () => {
    const sim = newSim({ firefox: true });
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1);
    advance(12_000);
    await sim.blur(); // 42 s
    advance(30 * SECOND);
    await sim.focusWindow(sim.windowId); // 72 s
    advance(3000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 42_000],
      ["a.test/a", 72_000, 75_000],
    ]);
  });

  it("follows the window that getLastFocused reports as focused: the new window's page opens, the old one's closes", async () => {
    // Firefox (headless) reports a newly opened window as the focused one, like a user switching
    // windows. The main window is no longer the focused one.
    const sim = newSim({ firefox: true });
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(2000);
    const other = await sim.openWindow({ focus: true });
    await sim.navigate(other.tabId, B);
    expect(sim.browser.mustWindow(sim.windowId).focused).toBe(false);
    advance(3000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 2000],
      ["b.test/b", 2000, 5000],
    ]);
  });
});

describe("focus segments: level-triggered convergence", () => {
  it("corrects a missed event on the next heartbeat", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1); // 30 s
    sim.browser.setUnfocusedAll(); // the blur event never arrived
    advance(20_000);
    await sim.heartbeat(); // 50 s
    expect(view(sim)).toEqual([["a.test/a", 0, 50_000]]);
  });

  it("gives the same result for a duplicated, reordered, concurrent burst of events as for one event", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1000);
    const second = await sim.openTab();
    await sim.navigate(second, B);
    advance(4000);
    sim.browser.setActive(sim.tabId);
    const windowId = sim.windowId;
    await Promise.all([
      sim.fire.tabActivated({ tabId: sim.tabId, windowId }),
      sim.fire.windowFocusChanged(windowId),
      sim.fire.tabActivated({ tabId: sim.tabId, windowId }),
      sim.fire.heartbeat(),
      sim.fire.tabActivated({ tabId: sim.tabId, windowId }),
    ]);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 1000],
      ["b.test/b", 1000, 5000],
      ["a.test/a", 5000, 7000],
    ]);
  });

  it.each([
    ["windows.getLastFocused", "getLastFocused"],
    ["tabs.query", "tabsQuery"],
  ] as const)(
    "closes the segment when %s fails, and reopens it once it works again",
    async (_name, kind) => {
      const sim = newSim();
      await sim.start();
      await sim.navigate(sim.tabId, A);
      advance(3000);
      sim.browser.fail[kind] = true;
      await expect(sim.heartbeat()).resolves.toBeUndefined();
      expect(view(sim)).toEqual([["a.test/a", 0, 3000]]);
      sim.browser.fail[kind] = false;
      advance(2000);
      await sim.heartbeat();
      advance(1000);
      await sim.blur();
      expect(view(sim)).toEqual([
        ["a.test/a", 0, 3000],
        ["a.test/a", 5000, 6000],
      ]);
    },
  );

  it("measures a boundary at the event time within 2 s even when every browser query is slow", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    sim.browser.queryDelayMs = 300;
    advance(3000);
    const second = await sim.openTab();
    await sim.navigate(second, B);
    sim.browser.queryDelayMs = 0;
    const [first, next] = sim.segments();
    expect(first?.domain).toBe("a.test");
    // The switch happened at 3000 ms; the queries made the engine's own clock reads later.
    expect((first?.endedAt ?? 0) - T0).toBeGreaterThanOrEqual(3000);
    expect((first?.endedAt ?? 0) - T0 - 3000).toBeLessThan(2000);
    expect(next).toBeUndefined();
  });
});

describe("focus segments: durations", () => {
  it("never emits a zero-length segment, and still clears the open state", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.navigate(sim.tabId, B); // same millisecond: A has no duration
    advance(1000);
    await sim.blur();
    expect(view(sim)).toEqual([["b.test/b", 0, 1000]]);
  });

  it("never emits a negative duration when the clock moves backwards", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(-5000); // system clock corrected backwards
    await sim.blur();
    expect(sim.segments()).toEqual([]);
    await sim.focusWindow(sim.windowId);
    advance(2000);
    await sim.blur();
    expect(sim.segments().map((s) => s.durationMs)).toEqual([2000]);
    expect(sim.segments().every((s) => s.durationMs > 0)).toBe(true);
  });

  it("splits continuous attention into back-to-back segments of exactly 30 minutes on the heartbeat", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(130); // 65 minutes, a heartbeat every 30 s
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 30 * MINUTE],
      ["a.test/a", 30 * MINUTE, 60 * MINUTE],
    ]);
    await sim.blur();
    expect(view(sim).at(-1)).toEqual(["a.test/a", 60 * MINUTE, 65 * MINUTE]);
    expect(sim.segments().every((s) => s.durationMs <= FOCUS_SEGMENT_MAX_MS)).toBe(true);
  });

  it("splits 75 minutes into 30, 30 and 15 minutes with nothing dropped", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(150);
    await sim.blur();
    expect(sim.segments().map((s) => s.durationMs)).toEqual([
      30 * MINUTE,
      30 * MINUTE,
      15 * MINUTE,
    ]);
  });

  it("keeps the attention past 30 minutes when a closing event comes before the heartbeat split", async () => {
    // ADR 0002 limitation: a segment closed at 30:20 must not lose the 20 s above the cap.
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(59); // last step at 29:30
    advance(50 * SECOND); // 30:20, no heartbeat in between (less than the 90 s gap)
    await sim.navigate(sim.tabId, B);
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 30 * MINUTE],
      ["a.test/a", 30 * MINUTE, 30 * MINUTE + 20 * SECOND],
    ]);
    expect(sim.segments().reduce((sum, s) => sum + s.durationMs, 0)).toBe(
      30 * MINUTE + 20 * SECOND,
    );
  });

  it("gives every segment event an endedAt/startedAt/durationMs that agree, in UTC ISO form", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1234);
    await sim.blur();
    const [event] = sim.ofType("browser.focus_segment");
    expect(event?.data).toEqual({
      domain: "a.test",
      path: "/a",
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 1234).toISOString(),
      durationMs: 1234,
    });
    const occurredAt = Date.parse(event?.occurredAt ?? "");
    expect(occurredAt).toBeGreaterThanOrEqual(T0);
    expect(occurredAt).toBeLessThanOrEqual(T0 + 1234);
  });
});

describe("focus segments: a gap in the same session", () => {
  it("closes at the last step after a long silence (sleep), then reopens when the page is still focused", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1); // 30 s
    advance(10 * MINUTE - 30 * SECOND); // 10 min with no step: the machine slept
    await sim.heartbeat();
    advance(5000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 30_000],
      ["a.test/a", 10 * MINUTE, 10 * MINUTE + 5000],
    ]);
  });

  it("does not let a page load right after waking hide the gap", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1); // 30 s
    advance(120 * SECOND); // 150 s
    await sim.navigate(sim.tabId, B);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 30_000],
      ["b.test/b", 150_000, 152_000],
    ]);
  });
});
