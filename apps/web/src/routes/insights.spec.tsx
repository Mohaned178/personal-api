import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

// M8-03 Insights home: today's and the last 7 days' time, a 7-day bar chart and the top 10
// domains from /v1/activity/daily and /domains, with days cut in the user's time zone, and the
// grouped navigation.

const MIN = 60_000;
const NOW = new Date("2026-10-21T03:00:00.000Z"); // the evening of the 20th in Los Angeles

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Welcome done, so home never redirects to the wizard.
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

const activityCalls = (path: string) => backend.calls.filter((c) => c.path === path);

describe("Insights home", () => {
  it("shows a loading state until the activity arrives", async () => {
    let release = () => {};
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 3 }],
      domains: [{ domain: "example.com", activeMs: 30 * MIN, pageVisits: 3 }],
      hold: new Promise((resolve) => {
        release = resolve;
      }),
    };
    mount("/");
    expect((await screen.findByRole("status")).textContent).toMatch(/loading/i);
    release();
    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the empty state with a link to the wizard", async () => {
    const { router } = mount("/");
    expect(await screen.findByText(/no activity in the last 7 days/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /setup wizard/i }));
    // The link clears the "shown once" flag, so the wizard opens instead of bouncing home.
    await waitFor(() => expect(pathname(router)).toBe("/welcome"));
  });

  it("shows today's and the week's totals, the 7-day bars and the top domains", async () => {
    backend.activity = {
      days: [
        { date: "2026-10-14", activeMs: 10 * MIN, pageVisits: 1 },
        { date: "2026-10-18", activeMs: 65 * MIN, pageVisits: 4 },
        { date: "2026-10-20", activeMs: 20 * MIN, pageVisits: 2 },
      ],
      domains: Array.from({ length: 12 }, (_, i) => ({
        domain: `site${i}.example`,
        activeMs: (12 - i) * MIN,
        pageVisits: 1,
      })),
    };
    mount("/");

    expect((await screen.findByTestId("stat-Today")).textContent).toBe("20m");
    expect(screen.getByTestId("stat-Last 7 days").textContent).toBe("1h 35m");

    const bars = within(screen.getByRole("list", { name: /active time per day/i })).getAllByRole(
      "listitem",
    );
    expect(bars).toHaveLength(7);
    expect(bars[0]?.getAttribute("aria-label")).toMatch(/14: 10m$/);
    expect(bars[1]?.getAttribute("aria-label")).toMatch(/15: 0m$/);
    expect(bars[6]?.getAttribute("aria-label")).toMatch(/20: 20m$/);

    const top = within(screen.getByRole("list", { name: /top sites/i })).getAllByRole("listitem");
    expect(top).toHaveLength(10);
    expect(top[0]?.textContent).toContain("site0.example");
    expect(activityCalls("/v1/activity/domains")[0]?.search).toContain("limit=10");
  });

  it("asks for the last 7 days in the user's time zone", async () => {
    mount("/");
    await screen.findByText(/no activity/i);
    for (const path of ["/v1/activity/daily", "/v1/activity/domains"]) {
      const params = new URLSearchParams(activityCalls(path)[0]?.search);
      expect(params.get("from")).toBe("2026-10-14T07:00:00.000Z");
      expect(params.get("to")).toBe(NOW.toISOString());
    }
  });

  it("counts today by the local date, not the UTC one", async () => {
    backend.timeZone = "UTC";
    backend.activity = {
      days: [
        { date: "2026-10-20", activeMs: 5 * MIN, pageVisits: 1 },
        { date: "2026-10-21", activeMs: 40 * MIN, pageVisits: 1 },
      ],
      domains: [],
    };
    mount("/");
    expect((await screen.findByTestId("stat-Today")).textContent).toBe("40m");
    expect(screen.getByText(/days are cut in UTC/i)).toBeTruthy();
  });

  it("shows an error when the activity cannot load", async () => {
    delete backend.activity;
    mount("/", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load your activity/i)).toBeTruthy();
  });
});

describe("grouped navigation", () => {
  it("groups the pages", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const group = (name: string) =>
      within(within(nav).getByRole("region", { name }))
        .getAllByRole("link")
        .map((l) => l.textContent);
    expect(group("Sources")).toEqual(["Integrations", "Health"]);
    expect(group("Data")).toEqual(["Events", "Retention"]);
    expect(group("Developer")).toEqual(["Read keys", "Endpoints"]);
    for (const name of ["Insights", "Rules", "Settings"]) {
      expect(within(nav).getByRole("link", { name })).toBeTruthy();
    }
    expect(within(nav).getByRole("link", { name: "Insights" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });
});
