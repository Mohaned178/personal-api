import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daysWindow } from "@/lib/activity";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

// M9-07 categories, goals and the weekly summary. Categories and goals live in this browser; the
// numbers come from /v1/activity/domains, one call per local day.

const MIN = 60_000;
const NOW = new Date("2026-10-21T03:00:00.000Z"); // the evening of the 20th in Los Angeles
const ZONE = "America/Los_Angeles";
const site = (domain: string, minutes: number) => ({
  domain,
  activeMs: minutes * MIN,
  pageVisits: 1,
});

/** The `from` of the local day `ago` days before the 20th, which keys `domainsByFrom`. */
const fromOf = (ago: number) => daysWindow(NOW, ZONE, 1, ago).from;

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.setItem("personal-api.welcome-done", "1");
  backend = makeBackend({ authed: true, timeZone: ZONE, limits: [] });
  backend.activity = { days: [], domains: [] };
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("category split on Insights", () => {
  it("splits the week into productive, neutral and distracting", async () => {
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 100 * MIN, pageVisits: 3 }],
      domains: [
        site("youtube.com", 60),
        site("music.youtube.com", 20),
        site("github.com", 15),
        site("example.org", 5),
      ],
    };
    mount("/");
    expect(
      (await screen.findByTestId("split-distracting", {}, { timeout: 5000 })).textContent,
    ).toBe("1h 20m · 80%");
    expect(screen.getByTestId("split-productive").textContent).toBe("15m · 15%");
    expect(screen.getByTestId("split-neutral").textContent).toBe("5m · 5%");
    expect(screen.getByRole("img", { name: /distracting 80%/i })).toBeTruthy();
  });

  it("uses the edited list, and shows nothing without activity", async () => {
    window.localStorage.setItem(
      "personal-api.categories",
      JSON.stringify([{ pattern: "example.org", category: "productive" }]),
    );
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 10 * MIN, pageVisits: 1 }],
      domains: [site("youtube.com", 5), site("example.org", 5)],
    };
    mount("/");
    expect((await screen.findByTestId("split-productive")).textContent).toBe("5m · 50%");
    expect(screen.getByTestId("split-neutral").textContent).toBe("5m · 50%");
    cleanup();

    backend.activity = { days: [], domains: [] };
    mount("/");
    await screen.findByText(/no activity in the last 7 days/i);
    expect(screen.queryByTestId("split-neutral")).toBeNull();
  });

  it("clears the list and goals on sign out", async () => {
    window.localStorage.setItem("personal-api.categories", "[]");
    window.localStorage.setItem("personal-api.goals", '{"distracting":30}');
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(window.localStorage.getItem("personal-api.categories")).toBeNull());
    expect(window.localStorage.getItem("personal-api.goals")).toBeNull();
  });
});

describe("categories page", () => {
  it("is reachable from the navigation and needs a session", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Categories" }).getAttribute("href")).toBe(
      "/categories",
    );
    expect(within(nav).getByRole("link", { name: "Summary" }).getAttribute("href")).toBe(
      "/summary",
    );
    cleanup();

    backend.authed = false;
    const { router } = mount("/categories");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("lists the starting list and lets the user add, move and remove a site", async () => {
    mount("/categories");
    const distracting = await screen.findByRole("region", { name: /distracting sites/i });
    expect(within(distracting).getByText("youtube.com")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /neutral sites/i })).toBeNull();

    fireEvent.change(screen.getByLabelText("Site"), { target: { value: " Example.org " } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "neutral" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    const neutral = await screen.findByRole("region", { name: /neutral sites/i });
    expect(within(neutral).getByText("example.org")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Category of example.org"), {
      target: { value: "productive" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /neutral sites/i })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove youtube.com" }));
    await waitFor(() => expect(screen.queryByText("youtube.com")).toBeNull());

    const saved = JSON.parse(
      window.localStorage.getItem("personal-api.categories") ?? "[]",
    ) as Array<{
      pattern: string;
      category: string;
    }>;
    expect(saved).toContainEqual({ pattern: "example.org", category: "productive" });
    expect(saved.some((e) => e.pattern === "youtube.com")).toBe(false);
    // Nothing went to the server.
    expect(backend.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("refuses a bad or repeated site, and resets to the starting list", async () => {
    mount("/categories");
    await screen.findByText("youtube.com");

    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "not a site" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/enter a site/i);

    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "youtube.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/already in the list/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove youtube.com" }));
    await waitFor(() => expect(screen.queryByText("youtube.com")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /reset to the starting list/i }));
    expect(await screen.findByText("youtube.com")).toBeTruthy();
  });
});

describe("goals and streak", () => {
  it("shows no progress until a goal is saved, and validates the minutes", async () => {
    mount("/categories");
    await screen.findByLabelText(/distracting sites: under/i);
    expect(screen.queryByRole("list", { name: /goal progress/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/distracting sites: under/i), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save goals" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/between 1 and 1440/i);
    expect(window.localStorage.getItem("personal-api.goals")).toBeNull();
  });

  it("counts the finished days in a row that stayed under the goal", async () => {
    backend.activity = {
      days: [],
      domains: [],
      domainsByFrom: {
        [fromOf(0)]: [site("youtube.com", 10)], // today: shown, not counted
        [fromOf(1)]: [site("youtube.com", 20), site("github.com", 5)], // met
        [fromOf(2)]: [site("youtube.com", 59)], // met
        [fromOf(3)]: [site("youtube.com", 90)], // over 60: ends the streak
        [fromOf(4)]: [site("youtube.com", 5)],
      },
    };
    mount("/categories");
    fireEvent.change(await screen.findByLabelText(/distracting sites: under/i), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save goals" }));

    expect((await screen.findByTestId("streak-distracting")).textContent).toBe(
      "Streak: 2 days in a row",
    );
    expect(screen.getByTestId("today-distracting").textContent).toMatch(/10m \(on track\)/);
    expect(JSON.parse(window.localStorage.getItem("personal-api.goals") ?? "{}")).toEqual({
      distracting: 60,
    });
  });

  it("ends the streak at a day with nothing tracked, and supports a productive floor", async () => {
    window.localStorage.setItem("personal-api.goals", '{"productive":60}');
    backend.activity = {
      days: [],
      domains: [],
      domainsByFrom: {
        [fromOf(0)]: [site("github.com", 20)],
        [fromOf(1)]: [site("github.com", 70)],
        [fromOf(2)]: [site("github.com", 60)],
        // Day 3 has nothing tracked.
        [fromOf(4)]: [site("github.com", 200)],
      },
    };
    mount("/categories");
    expect((await screen.findByTestId("streak-productive")).textContent).toBe(
      "Streak: 2 days in a row",
    );
    expect(screen.getByTestId("today-productive").textContent).toMatch(/20m \(not met yet\)/);
  });
});

describe("weekly summary", () => {
  it("shows the empty state", async () => {
    mount("/summary");
    expect(await screen.findByText(/no activity in the last two weeks/i)).toBeTruthy();
  });

  it("compares this week with last week, with limits kept and the biggest changes", async () => {
    backend.limits = [
      {
        id: "0192f1c2-7c1e-7a3b-9f00-0000000000a1",
        pattern: "youtube.com",
        minutes: 25,
        strict: false,
      },
    ];
    backend.activity = {
      days: [],
      domains: [],
      domainsByFrom: {
        [fromOf(0)]: [site("youtube.com", 30), site("github.com", 120)], // over the limit
        [fromOf(1)]: [site("youtube.com", 20)], // kept
        [fromOf(7)]: [site("youtube.com", 100), site("example.org", 10)], // last week
      },
    };
    mount("/summary");

    const distracting = await screen.findByTestId("row-distracting");
    expect(
      within(distracting)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["50m", "1h 40m", "-50m"]);
    const productive = screen.getByTestId("row-productive");
    expect(
      within(productive)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2h 00m", "0m", "+2h 00m"]);
    const total = screen.getByTestId("row-total");
    expect(
      within(total)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2h 50m", "1h 50m", "+1h 00m"]);
    expect(screen.getByTestId("limits-kept").textContent).toMatch(/1 of 2 limit-days/);

    const up = screen.getByRole("region", { name: "Up most" });
    expect(within(up).getByRole("link", { name: "github.com" })).toBeTruthy();
    const down = screen.getByRole("region", { name: "Down most" });
    expect(within(down).getByRole("link", { name: "youtube.com" })).toBeTruthy();
    expect(within(down).getByRole("link", { name: "example.org" })).toBeTruthy();
  });

  it("says when there are no limits, and when a request fails", async () => {
    backend.activity = {
      days: [],
      domains: [],
      domainsByFrom: { [fromOf(0)]: [site("github.com", 5)] },
    };
    mount("/summary");
    expect(await screen.findByText(/you have no limits yet/i)).toBeTruthy();
    cleanup();

    delete backend.limits;
    mount("/summary", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect((await screen.findByText(/could not load your summary/i)).textContent).toBeTruthy();
  });
});
