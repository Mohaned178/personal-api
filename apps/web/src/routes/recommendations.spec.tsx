import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount } from "@/test/auth-harness";

// M9-04 recommendations: shown on Insights and the per-site page, applied as M9-02 limits through
// /v1/limits, dismissible, and silent while loading, empty or failing.

const MIN = 60_000;
const NOW = new Date("2026-10-21T03:00:00.000Z");
const LIMIT_ID = "0192f1c2-7c1e-7a3b-9f00-000000000009";

const plan = {
  kind: "limit_plan",
  domain: "youtube.com",
  averageMinutes: 95,
  steps: [90, 75, 60],
};
const step = {
  kind: "limit_step",
  limitId: LIMIT_ID,
  pattern: "reddit.com",
  strict: true,
  currentMinutes: 60,
  nextMinutes: 45,
};
const night = {
  kind: "late_night",
  domain: "youtube.com",
  sharePercent: 70,
  fromHour: 23,
  toHour: 7,
};

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.setItem("personal-api.welcome-done", "1");
  backend = makeBackend({
    authed: true,
    timeZone: "UTC",
    limits: [{ id: LIMIT_ID, pattern: "reddit.com", minutes: 60, strict: true }],
    activity: {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 3 }],
      domains: [{ domain: "youtube.com", activeMs: 30 * MIN, pageVisits: 3 }],
      site: {
        days: [],
        activeMs: 30 * MIN,
        pageVisits: 3,
        sessions: 1,
        averageSessionMs: 30 * MIN,
        longestSessionMs: 30 * MIN,
        paths: [],
      },
    },
  });
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Recommendations on Insights", () => {
  it("shows nothing without suggestions", async () => {
    backend.recommendations = [];
    mount("/");
    await screen.findByTestId("stat-Today");
    await waitFor(() =>
      expect(backend.calls.some((c) => c.path === "/v1/recommendations")).toBe(true),
    );
    expect(screen.queryByRole("heading", { name: "Suggestions" })).toBeNull();
  });

  it("shows nothing, and no error, when the suggestions cannot load", async () => {
    mount("/");
    await screen.findByTestId("stat-Today");
    expect(screen.queryByRole("heading", { name: "Suggestions" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("describes each kind of suggestion", async () => {
    backend.recommendations = [step, plan, night];
    mount("/");
    const cards = await screen.findAllByTestId("recommendation");
    expect(cards).toHaveLength(3);
    expect(
      within(cards[0] as HTMLElement).getByText(/tighten your limit on reddit\.com/i),
    ).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText(/lower it to 45m/i)).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText(/1h 35m a day/)).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText(/1h 30m → 1h 15m → 1h 00m/)).toBeTruthy();
    expect(within(cards[2] as HTMLElement).getByText(/70% .* 23:00 and 07:00/)).toBeTruthy();
    expect(
      within(cards[2] as HTMLElement).getByRole("button", { name: "Block 23:00 to 07:00" }),
    ).toBeTruthy();
    expect(
      within(cards[2] as HTMLElement).queryByRole("button", { name: /limit|lower/i }),
    ).toBeNull();
  });

  it("applies a late-night hint as a schedule for those hours, every day (M9-06)", async () => {
    backend.recommendations = [night];
    backend.schedules = [];
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: "Block 23:00 to 07:00" }));
    await waitFor(() =>
      expect(
        backend.calls.find((c) => c.method === "POST" && c.path === "/v1/schedules")?.body,
      ).toEqual({
        name: "youtube.com at night",
        patterns: ["youtube.com"],
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "23:00",
        end: "07:00",
        enabled: true,
      }),
    );
  });

  it("applies a plan as a limit on its first step", async () => {
    backend.recommendations = [plan];
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: "Set a 1h 30m limit" }));
    await waitFor(() =>
      expect(
        backend.calls.find((c) => c.method === "POST" && c.path === "/v1/limits")?.body,
      ).toEqual({
        pattern: "youtube.com",
        minutes: 90,
        strict: false,
      }),
    );
  });

  it("applies a step by replacing the limit, keeping strict", async () => {
    backend.recommendations = [step];
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: "Lower to 45m" }));
    await waitFor(() =>
      expect(
        backend.calls.find((c) => c.method === "PUT" && c.path === `/v1/limits/${LIMIT_ID}`)?.body,
      ).toEqual({ pattern: "reddit.com", minutes: 45, strict: true }),
    );
  });

  it("says so when applying fails, and keeps the suggestion", async () => {
    backend.recommendations = [plan];
    backend.limits = [{ id: LIMIT_ID, pattern: "youtube.com", minutes: 60, strict: false }];
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: "Set a 1h 30m limit" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not apply/i);
    expect(screen.getByTestId("recommendation")).toBeTruthy();
  });

  it("dismisses a suggestion and remembers it in this browser", async () => {
    backend.recommendations = [plan, night];
    mount("/");
    const cards = await screen.findAllByTestId("recommendation");
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(screen.getAllByTestId("recommendation")).toHaveLength(1);
    cleanup();
    mount("/");
    expect(await screen.findAllByTestId("recommendation")).toHaveLength(1);
    expect(screen.queryByText(/cut back on youtube\.com/i)).toBeNull();
  });
});

describe("Recommendations on the site page", () => {
  it("shows only the suggestions about that site", async () => {
    backend.recommendations = [step, plan, night];
    mount("/sites/youtube.com");
    const cards = await screen.findAllByTestId("recommendation");
    expect(cards).toHaveLength(2);
    expect(screen.queryByText(/reddit\.com/)).toBeNull();
  });

  it("matches a limit step to the site its pattern covers", async () => {
    backend.recommendations = [
      { ...step, pattern: "*.reddit.com", nextMinutes: 45, currentMinutes: 60 },
    ];
    mount("/sites/old.reddit.com");
    expect(await screen.findByText(/tighten your limit on \*\.reddit\.com/i)).toBeTruthy();
  });
});
