import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount } from "@/test/auth-harness";

// M9-03 Patterns page: today's sessions, this week against last week per site, and the
// weekday-by-hour heatmap, with days cut in the user's time zone.

const MIN = 60_000;
const NOW = new Date("2026-10-21T03:00:00.000Z"); // the evening of the 20th in Los Angeles

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.setItem("personal-api.welcome-done", "1");
  backend = makeBackend({
    authed: true,
    timeZone: "America/Los_Angeles",
    activity: { days: [], domains: [] },
  });
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const calls = (path: string) => backend.calls.filter((c) => c.path === path);
const noRetry = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("Patterns page", () => {
  it("shows a loading state in each view until the data arrives", async () => {
    let release = () => {};
    backend.activity = {
      days: [],
      domains: [],
      hold: new Promise((resolve) => {
        release = resolve;
      }),
    };
    mount("/patterns");
    expect((await screen.findAllByRole("status")).length).toBe(3);
    release();
    expect(await screen.findByText(/no sessions yet today/i)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows an empty state for each view", async () => {
    mount("/patterns");
    expect(await screen.findByText(/no sessions yet today/i)).toBeTruthy();
    expect(screen.getByText(/no activity in the last 2 weeks/i)).toBeTruthy();
    expect(screen.getByText(/no activity in the last 4 weeks/i)).toBeTruthy();
  });

  it("shows an error for a view that cannot load", async () => {
    delete backend.activity;
    mount("/patterns", noRetry());
    expect((await screen.findAllByText(/could not load this view/i)).length).toBe(3);
  });

  it("lists today's sessions oldest first, in the user's zone, from local midnight", async () => {
    backend.activity = {
      days: [],
      domains: [],
      sessions: [
        {
          id: "2",
          domain: "late.test",
          startedAt: "2026-10-21T02:00:00.000Z",
          endedAt: "2026-10-21T02:30:00.000Z",
          durationMs: 30 * MIN,
        },
        {
          id: "1",
          domain: "early.test",
          startedAt: "2026-10-20T16:00:00.000Z",
          endedAt: "2026-10-20T16:10:00.000Z",
          durationMs: 10 * MIN,
        },
      ],
    };
    mount("/patterns");
    const list = await screen.findByRole("list", { name: /today's sessions/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/09:00 to 09:10.*early\.test.*10m/),
      expect.stringMatching(/19:00 to 19:30.*late\.test.*30m/),
    ]);
    const params = new URLSearchParams(calls("/v1/activity/sessions")[0]?.search);
    expect(params.get("from")).toBe("2026-10-20T07:00:00.000Z");
    expect(params.get("to")).toBe(NOW.toISOString());
  });

  it("follows the sessions cursor to the last page", async () => {
    backend.activity = {
      days: [],
      domains: [],
      sessions: Array.from({ length: 250 }, (_, i) => ({
        id: String(i),
        domain: "a.test",
        startedAt: "2026-10-20T16:00:00.000Z",
        endedAt: "2026-10-20T16:01:00.000Z",
        durationMs: MIN,
      })),
    };
    mount("/patterns");
    const list = await screen.findByRole("list", { name: /today's sessions/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(250);
    expect(calls("/v1/activity/sessions")).toHaveLength(2);
  });

  it("compares this week with last week from two windows, busiest this week first", async () => {
    backend.activity = {
      days: [],
      domains: [{ domain: "x.test", activeMs: 20 * MIN, pageVisits: 1 }],
      domainsByFrom: {
        "2026-10-14T07:00:00.000Z": [
          { domain: "a.test", activeMs: 60 * MIN, pageVisits: 3 },
          { domain: "b.test", activeMs: 30 * MIN, pageVisits: 1 },
        ],
        "2026-10-07T07:00:00.000Z": [
          { domain: "b.test", activeMs: 45 * MIN, pageVisits: 1 },
          { domain: "gone.test", activeMs: 5 * MIN, pageVisits: 1 },
        ],
      },
    };
    mount("/patterns");
    const table = await screen.findByRole("table", { name: /this week against last week/i });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "a.test1h 00m0m+1h 00m",
      "b.test30m45m-15m",
      "gone.test0m5m-5m",
    ]);
    const asked = calls("/v1/activity/domains").map((c) => new URLSearchParams(c.search));
    expect(asked.map((p) => p.get("from")).sort()).toEqual([
      "2026-10-07T07:00:00.000Z",
      "2026-10-14T07:00:00.000Z",
    ]);
    const last = asked.find((p) => p.get("from") === "2026-10-07T07:00:00.000Z");
    expect(last?.get("to")).toBe("2026-10-14T07:00:00.000Z");
  });

  it("draws the heatmap with one cell per weekday and hour, over the last 4 local weeks", async () => {
    backend.activity = {
      days: [],
      domains: [],
      hours: [
        { weekday: 0, hour: 9, activeMs: 30 * MIN },
        { weekday: 6, hour: 23, activeMs: 5 * MIN },
      ],
    };
    mount("/patterns");
    const table = await screen.findByRole("table", { name: /by weekday and hour/i });
    expect(within(table).getAllByRole("cell")).toHaveLength(7 * 24);
    expect(within(table).getByLabelText("Mon 09:00: 30m")).toBeTruthy();
    expect(within(table).getByLabelText("Sun 23:00: 5m")).toBeTruthy();
    expect(within(table).getByLabelText("Tue 03:00: 0m")).toBeTruthy();
    const params = new URLSearchParams(calls("/v1/activity/hours")[0]?.search);
    expect(params.get("from")).toBe("2026-09-23T07:00:00.000Z");
    expect(params.get("to")).toBe(NOW.toISOString());
  });
});
