import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount } from "@/test/auth-harness";

// M9-03 per-site page: 30 days of time, visits, average and longest session, top pages.

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

describe("Site page", () => {
  it("shows a loading state until the site arrives", async () => {
    let release = () => {};
    backend.activity = {
      days: [],
      domains: [],
      hold: new Promise((resolve) => {
        release = resolve;
      }),
    };
    mount("/sites/example.com");
    expect((await screen.findByRole("status")).textContent).toMatch(/loading/i);
    release();
    expect(await screen.findByText(/no activity on this site/i)).toBeTruthy();
  });

  it("shows an empty state for a site with no activity", async () => {
    mount("/sites/example.com");
    expect(await screen.findByRole("heading", { name: "example.com" })).toBeTruthy();
    expect(await screen.findByText(/no activity on this site in the last 30 days/i)).toBeTruthy();
  });

  it("shows an error when the site cannot load", async () => {
    delete backend.activity;
    mount("/sites/example.com", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load this site/i)).toBeTruthy();
  });

  it("shows the totals, 30 day bars with the gaps filled, and the top pages", async () => {
    backend.activity = {
      days: [],
      domains: [],
      site: {
        days: [
          { date: "2026-10-18", activeMs: 65 * MIN, pageVisits: 4 },
          { date: "2026-10-20", activeMs: 20 * MIN, pageVisits: 2 },
        ],
        activeMs: 85 * MIN,
        pageVisits: 6,
        sessions: 4,
        averageSessionMs: 21 * MIN,
        longestSessionMs: 40 * MIN,
        paths: [
          { path: "/watch", activeMs: 60 * MIN, pageVisits: 3 },
          { path: "/", activeMs: 25 * MIN, pageVisits: 3 },
        ],
      },
    };
    mount("/sites/example.com");
    expect((await screen.findByTestId("stat-Time")).textContent).toBe("1h 25m");
    expect(screen.getByTestId("stat-Visits").textContent).toBe("6");
    expect(screen.getByTestId("stat-Average session").textContent).toBe("21m");
    expect(screen.getByTestId("stat-Longest session").textContent).toBe("40m");

    const bars = within(screen.getByRole("list", { name: /active time per day/i })).getAllByRole(
      "listitem",
    );
    expect(bars).toHaveLength(30);
    expect(bars[0]?.getAttribute("aria-label")).toBe("Sep 21: 0m");
    expect(bars[27]?.getAttribute("aria-label")).toBe("Oct 18: 1h 05m");
    expect(bars[29]?.getAttribute("aria-label")).toBe("Oct 20: 20m");

    const pages = within(screen.getByRole("list", { name: /top pages/i })).getAllByRole("listitem");
    expect(pages.map((p) => p.textContent)).toEqual(["/watch1h 00m", "/25m"]);

    const call = backend.calls.find((c) => c.path === "/v1/activity/site");
    const params = new URLSearchParams(call?.search);
    expect(params.get("domain")).toBe("example.com");
    expect(params.get("from")).toBe("2026-09-21T07:00:00.000Z");
    expect(params.get("to")).toBe(NOW.toISOString());
  });

  it("links the Insights top sites to their page", async () => {
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 5 * MIN, pageVisits: 1 }],
      domains: [{ domain: "example.com", activeMs: 5 * MIN, pageVisits: 1 }],
    };
    mount("/");
    const link = await screen.findByRole("link", { name: "example.com" });
    expect(link.getAttribute("href")).toBe("/sites/example.com");
  });
});
