import { describe, expect, it } from "vitest";
import {
  capture,
  cleared,
  GAP_MS,
  IDLE_DETECTION_S,
  initialState,
  type PersistedState,
  reduceUrl,
  SEGMENT_CAP_MS,
  type StepInput,
  step,
  type TabInfo,
} from "../lib/core";

const S1 = "session-1";
const S2 = "session-2";

let counter = 0;
const newId = () => `id-${++counter}`;

const tab = (tabId: number, url: string, extra: Partial<TabInfo> = {}): TabInfo => ({
  tabId,
  url,
  incognito: false,
  status: "complete",
  ...extra,
});

const focusStep = (
  prev: PersistedState,
  input: Partial<StepInput> & { now: number },
): ReturnType<typeof step> =>
  step(prev, { session: S1, focused: null, idle: "active", ...input }, newId);

const segmentsOf = (events: ReturnType<typeof step>["events"]) =>
  events.flatMap((e) => (e.type === "focus_segment" ? [e] : []));

describe("reduceUrl", () => {
  it.each([
    ["https://example.com/a/b?q=secret#frag", { domain: "example.com", path: "/a/b" }],
    ["http://127.0.0.1:5173/b?x=1", { domain: "127.0.0.1", path: "/b" }],
    ["https://user:pass@example.com/", { domain: "example.com", path: "/" }],
    ["https://example.com", { domain: "example.com", path: "/" }],
  ])("keeps only domain and path of %s", (url, expected) => {
    expect(reduceUrl(url)).toEqual(expected);
  });

  it.each([
    "about:blank",
    "chrome://newtab/",
    "chrome-extension://abc/popup.html",
    "data:text/html,hi",
    "file:///C:/x.html",
    "not a url",
    "",
    undefined,
  ])("ignores %s", (url) => {
    expect(reduceUrl(url)).toBeNull();
  });

  it("never returns anything from the query string or fragment", () => {
    const out = JSON.stringify(reduceUrl("https://example.com/p?token=secret&x=1#frag"));
    expect(out).not.toMatch(/secret|token|frag|\?/);
  });
});

describe("capture", () => {
  it("emits one page_visited per completed http(s) navigation", () => {
    const { state, events } = capture(
      initialState(),
      { now: 1_000, session: S1, tab: tab(7, "https://example.com/a?q=1") },
      newId,
    );
    expect(events).toEqual([
      {
        id: expect.any(String),
        type: "page_visited",
        domain: "example.com",
        path: "/a",
        ts: 1_000,
      },
    ]);
    expect(state.tabs["7"]).toMatchObject({ page: "example.com/a", recovered: false });
  });

  it("counts a reload of the same page again", () => {
    const first = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "https://e.com/a") },
      newId,
    );
    const second = capture(
      first.state,
      { now: 2, session: S1, tab: tab(1, "https://e.com/a") },
      newId,
    );
    expect(second.events).toHaveLength(1);
  });

  it("ignores incognito tabs and non-http(s) pages", () => {
    const incognito = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "https://e.com/", { incognito: true }) },
      newId,
    );
    expect(incognito.events).toEqual([]);
    expect(incognito.state.tabs).toEqual({});
    const blank = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "about:blank") },
      newId,
    );
    expect(blank.events).toEqual([]);
  });

  it("skips the late event of a visit that reconciliation already recovered, once", () => {
    const recovered = focusStep(initialState(), {
      now: 10,
      openTabs: { tabs: [tab(3, "https://e.com/x")], at: 10 },
    });
    expect(recovered.events.filter((e) => e.type === "page_visited")).toHaveLength(1);
    const late = capture(
      recovered.state,
      { now: 9, session: S1, tab: tab(3, "https://e.com/x") },
      newId,
    );
    expect(late.events).toEqual([]);
    const reload = capture(
      late.state,
      { now: 20, session: S1, tab: tab(3, "https://e.com/x") },
      newId,
    );
    expect(reload.events).toHaveLength(1);
  });
});

describe("step: visit reconciliation on worker start", () => {
  it("recovers a completed navigation whose event never committed", () => {
    const before = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "https://e.com/a") },
      newId,
    );
    const { events, state } = focusStep(before.state, {
      now: 50,
      openTabs: { tabs: [tab(1, "https://e.com/b")], at: 50 },
    });
    expect(events.filter((e) => e.type === "page_visited")).toMatchObject([{ path: "/b" }]);
    expect(state.diag.recoveredVisits).toBe(1);
  });

  it("does not re-emit a page that is already recorded, or one still loading", () => {
    const before = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "https://e.com/a") },
      newId,
    );
    const { events } = focusStep(before.state, {
      now: 50,
      openTabs: {
        tabs: [tab(1, "https://e.com/a"), tab(2, "https://e.com/c", { status: "loading" })],
        at: 50,
      },
    });
    expect(events.filter((e) => e.type === "page_visited")).toEqual([]);
  });

  it("trusts a mark written after the tab list was read", () => {
    const newer = capture(
      initialState(),
      { now: 60, session: S1, tab: tab(1, "https://e.com/b") },
      newId,
    );
    const { events } = focusStep(newer.state, {
      now: 50,
      openTabs: { tabs: [tab(1, "https://e.com/a")], at: 50 },
    });
    expect(events.filter((e) => e.type === "page_visited")).toEqual([]);
  });

  it("ignores marks from a previous browser session (tab ids are reused)", () => {
    const old = capture(
      initialState(),
      { now: 1, session: S1, tab: tab(1, "https://e.com/a") },
      newId,
    );
    const { events, state } = step(
      old.state,
      {
        now: 100,
        session: S2,
        focused: null,
        idle: "active",
        openTabs: { tabs: [tab(1, "https://e.com/a")], at: 100 },
      },
      newId,
    );
    expect(events.filter((e) => e.type === "page_visited")).toHaveLength(1);
    expect(state.tabs["1"]?.session).toBe(S2);
  });
});

describe("step: focus segments", () => {
  it("opens on the focused http(s) tab and closes on tab switch, back to back", () => {
    const a = focusStep(initialState(), { now: 1_000, focused: tab(1, "https://e.com/a") });
    expect(a.state.open).toMatchObject({ path: "/a", startedAt: 1_000 });
    const b = focusStep(a.state, { now: 4_000, focused: tab(2, "https://e.com/b") });
    expect(segmentsOf(b.events)).toMatchObject([
      { path: "/a", startedAt: 1_000, endedAt: 4_000, durationMs: 3_000 },
    ]);
    expect(b.state.open).toMatchObject({ path: "/b", startedAt: 4_000 });
  });

  it("closes on navigation away within the same tab", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const b = focusStep(a.state, { now: 500, focused: tab(1, "https://e.com/b") });
    expect(segmentsOf(b.events)).toMatchObject([{ path: "/a", durationMs: 500 }]);
  });

  it("closes on blur, and when the focused window shows a non-http(s) page", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const blurred = focusStep(a.state, { now: 2_000, focused: null });
    expect(segmentsOf(blurred.events)).toMatchObject([{ durationMs: 2_000 }]);
    expect(blurred.state.open).toBeNull();
    const other = focusStep(a.state, { now: 2_000, focused: tab(9, "about:blank") });
    expect(segmentsOf(other.events)).toMatchObject([{ durationMs: 2_000 }]);
    expect(other.state.open).toBeNull();
  });

  it("does nothing while the same page stays focused", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const again = focusStep(a.state, { now: 5_000, focused: tab(1, "https://e.com/a?other=1") });
    expect(again.events).toEqual([]);
    expect(again.state.open).toEqual(a.state.open);
  });

  it("never opens a segment for incognito tabs", () => {
    const { state } = focusStep(initialState(), {
      now: 0,
      focused: tab(1, "https://e.com/a", { incognito: true }),
    });
    expect(state.open).toBeNull();
  });

  it("ends the segment at the last input on idle, and at once on lock", () => {
    const opened = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    // A heartbeat in between, so the idle step is not mistaken for a gap.
    const a = focusStep(opened.state, { now: 60_000, focused: tab(1, "https://e.com/a") });
    const idle = focusStep(a.state, {
      now: 100_000,
      focused: tab(1, "https://e.com/a"),
      idle: "idle",
    });
    expect(segmentsOf(idle.events)).toMatchObject([
      { endedAt: 100_000 - IDLE_DETECTION_S * 1000, durationMs: 40_000 },
    ]);
    expect(idle.state.open).toBeNull();
    const locked = focusStep(a.state, {
      now: 7_000,
      focused: tab(1, "https://e.com/a"),
      idle: "locked",
    });
    expect(segmentsOf(locked.events)).toMatchObject([{ endedAt: 7_000 }]);
    // Back to active: a new segment opens.
    const back = focusStep(locked.state, { now: 9_000, focused: tab(1, "https://e.com/a") });
    expect(back.state.open).toMatchObject({ startedAt: 9_000 });
  });

  it("never ends before it started when idle fires soon after opening", () => {
    const a = focusStep(initialState(), { now: 50_000, focused: tab(1, "https://e.com/a") });
    const idle = focusStep(a.state, {
      now: 70_000,
      focused: tab(1, "https://e.com/a"),
      idle: "idle",
    });
    expect(segmentsOf(idle.events)).toMatchObject([{ durationMs: 0 }]);
  });

  it("splits continuous attention into back-to-back segments of at most 30 minutes", () => {
    let state = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") }).state;
    const all = [];
    for (let now = 30_000; now <= 65 * 60_000; now += 30_000) {
      const out = focusStep(state, { now, focused: tab(1, "https://e.com/a") });
      all.push(...segmentsOf(out.events));
      state = out.state;
    }
    expect(all).toMatchObject([
      { startedAt: 0, endedAt: SEGMENT_CAP_MS, durationMs: SEGMENT_CAP_MS },
      { startedAt: SEGMENT_CAP_MS, endedAt: 2 * SEGMENT_CAP_MS, durationMs: SEGMENT_CAP_MS },
    ]);
    expect(state.open?.startedAt).toBe(2 * SEGMENT_CAP_MS);
    expect(state.diag.capSplits).toBe(2);
  });

  it("caps a segment closed late at 30 minutes", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const late = focusStep(
      { ...a.state, lastAliveAt: 3 * 60 * 60_000 },
      { now: 3 * 60 * 60_000, focused: null },
    );
    expect(segmentsOf(late.events)).toMatchObject([{ durationMs: SEGMENT_CAP_MS }]);
  });
});

describe("step: recovery after a browser restart or a gap", () => {
  it("closes the previous session's open segment at the last heartbeat, not now", () => {
    const a = focusStep(initialState(), { now: 1_000, focused: tab(1, "https://e.com/a") });
    const beat = focusStep(a.state, { now: 31_000, focused: tab(1, "https://e.com/a") });
    const restarted = step(
      beat.state,
      { now: 10 * 60_000, session: S2, focused: null, idle: "active" },
      newId,
    );
    expect(segmentsOf(restarted.events)).toMatchObject([
      { path: "/a", startedAt: 1_000, endedAt: 31_000, durationMs: 30_000 },
    ]);
    expect(restarted.state.open).toBeNull();
    expect(restarted.state.diag.restartRecoveries).toBe(1);
  });

  it("recovers exactly once, even if the first step after the restart is retried", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const once = step(a.state, { now: 100_000, session: S2, focused: null, idle: "active" }, newId);
    const twice = step(
      once.state,
      { now: 100_500, session: S2, focused: null, idle: "active" },
      newId,
    );
    expect(segmentsOf(twice.events)).toEqual([]);
  });

  it("closes at the last heartbeat after a gap in the same session (sleep), then reopens", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const wake = focusStep(a.state, { now: GAP_MS + 60_000, focused: tab(1, "https://e.com/a") });
    expect(segmentsOf(wake.events)).toMatchObject([{ startedAt: 0, endedAt: 0, durationMs: 0 }]);
    expect(wake.state.open).toMatchObject({ startedAt: GAP_MS + 60_000 });
    expect(wake.state.diag.gapCloses).toBe(1);
  });

  it("keeps a segment open across a worker restart in the same session", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const start = focusStep(a.state, {
      now: 1_500,
      focused: tab(1, "https://e.com/a"),
      openTabs: { tabs: [tab(1, "https://e.com/a")], at: 1_500 },
    });
    expect(segmentsOf(start.events)).toEqual([]);
    expect(start.state.open?.startedAt).toBe(0);
  });
});

describe("cleared", () => {
  it("drops the open segment and keeps tab marks", () => {
    const a = focusStep(initialState(), { now: 0, focused: tab(1, "https://e.com/a") });
    const marked = capture(a.state, { now: 1, session: S1, tab: tab(1, "https://e.com/a") }, newId);
    const { state, events } = cleared(marked.state);
    expect(state.open).toBeNull();
    expect(state.tabs["1"]).toBeDefined();
    expect(events).toEqual([]);
  });
});
