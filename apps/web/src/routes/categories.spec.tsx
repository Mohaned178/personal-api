import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daysWindow } from "@/lib/activity";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

// M9-07 categories and goals: the editor page, the split and goal streak on Insights, and the
// weekly summary, on fixed data. Only Date is faked, so timers and promises behave.

const MIN = 60_000;
const ZONE = "America/Los_Angeles";
const NOW = new Date("2026-10-21T03:00:00.000Z"); // the evening of the 20th in Los Angeles

const REDDIT = {
  id: "0192f1c2-7c1e-7a3b-9f00-0000000000a1",
  pattern: "reddit.com",
  category: "neutral",
};
const BLOG = {
  id: "0192f1c2-7c1e-7a3b-9f00-0000000000a2",
  pattern: "*.blog.example",
  category: "productive",
};

const day = (date: string, productive: number, neutral: number, distracting: number) => ({
  date,
  productiveMs: productive * MIN,
  neutralMs: neutral * MIN,
  distractingMs: distracting * MIN,
});

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.setItem("personal-api.welcome-done", "1");
  backend = makeBackend({
    authed: true,
    timeZone: ZONE,
    activity: { days: [], domains: [] },
    categoryRules: [],
    limits: [],
    goals: [],
  });
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const writes = () => backend.calls.filter((c) => ["POST", "PUT", "DELETE"].includes(c.method));

describe("categories page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/categories");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("is reachable from the navigation, with the summary", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Categories" }).getAttribute("href")).toBe(
      "/categories",
    );
    expect(within(nav).getByRole("link", { name: "Summary" }).getAttribute("href")).toBe(
      "/summary",
    );
  });

  it("shows empty states, the built-in list and no goals set", async () => {
    mount("/categories");
    expect(await screen.findByText(/no sites of your own yet/i)).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getByText("youtube.com")).toBeTruthy();
    expect(screen.getByLabelText(/on distracting sites/i)).toHaveProperty("value", "");
  });

  it("shows a loading state, then the saved sites and goals", async () => {
    backend.categoryRules?.push(REDDIT, BLOG);
    backend.goals?.push({ category: "distracting", minutes: 60 });
    const real = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/categories") && (init?.method ?? "GET") === "GET") await gate;
      return real(input, init);
    }) as typeof fetch;
    mount("/categories");
    expect((await screen.findAllByText(/loading/i)).length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText("reddit.com")).toBeTruthy();
    expect(screen.getByText("*.blog.example")).toBeTruthy();
    expect(screen.getByLabelText("Category for reddit.com")).toHaveProperty("value", "neutral");
    expect(screen.getByLabelText(/on distracting sites/i)).toHaveProperty("value", "60");
  });

  it("shows an error when the sites cannot be loaded", async () => {
    delete backend.categoryRules;
    mount("/categories", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load categories/i)).toBeTruthy();
  });

  it("adds a site, lowercasing it, and lists it", async () => {
    mount("/categories");
    await screen.findByText(/no sites of your own yet/i);
    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "  News.Example " } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "distracting" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    expect(await screen.findByText("news.example")).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      body: { pattern: "news.example", category: "distracting" },
    });
  });

  it("does not send a url, and says why without repeating it", async () => {
    mount("/categories");
    await screen.findByText(/no sites of your own yet/i);
    fireEvent.change(screen.getByLabelText("Site"), {
      target: { value: "https://secret.example/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/enter a site such as/i);
    expect(alert.textContent).not.toMatch(/secret/);
    expect(writes()).toHaveLength(0);
  });

  it("explains a site that already has a category", async () => {
    backend.categoryRules?.push(REDDIT);
    mount("/categories");
    await screen.findByText("reddit.com");
    fireEvent.change(screen.getByLabelText("Site"), { target: { value: "reddit.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a category/i);
  });

  it("changes the category of a site, and removes one", async () => {
    backend.categoryRules?.push(REDDIT, BLOG);
    mount("/categories");
    await screen.findByText("reddit.com");
    fireEvent.change(screen.getByLabelText("Category for reddit.com"), {
      target: { value: "distracting" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Category for reddit.com")).toHaveProperty(
        "value",
        "distracting",
      ),
    );
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      body: { pattern: "reddit.com", category: "distracting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove *.blog.example" }));
    await waitFor(() => expect(screen.queryByText("*.blog.example")).toBeNull());
    expect(writes()[1]).toMatchObject({ method: "DELETE" });
  });

  it("sets a goal, then removes it", async () => {
    mount("/categories");
    const input = await screen.findByLabelText(/on distracting sites/i);
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the distracting goal" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/v1/goals/distracting",
      body: { minutes: 45 },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Remove the distracting goal" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove the distracting goal" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ method: "DELETE", path: "/v1/goals/distracting" });
  });

  it.each([
    ["zero", "0"],
    ["more than a day", "1441"],
  ])("does not send a goal of %s minutes", async (_label, minutes) => {
    mount("/categories");
    const input = await screen.findByLabelText(/on distracting sites/i);
    fireEvent.change(input, { target: { value: minutes } });
    expect(
      (screen.getByRole("button", { name: "Save the distracting goal" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });
});

describe("Insights: the split and goal streaks", () => {
  it("splits the week by category with shares", async () => {
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 1 }],
      domains: [{ domain: "example.com", activeMs: 30 * MIN, pageVisits: 1 }],
      categories: [day("2026-10-18", 60, 30, 30), day("2026-10-20", 10, 0, 20)],
    };
    mount("/");
    await screen.findByRole("heading", { name: "By category, last 7 days" });
    // 70m productive, 30m neutral, 50m distracting of 150m.
    expect((await screen.findByTestId("split-productive")).textContent).toMatch(/1h 10m.*47%/);
    expect(screen.getByTestId("split-neutral").textContent).toMatch(/30m.*20%/);
    expect(screen.getByTestId("split-distracting").textContent).toMatch(/50m.*33%/);
  });

  it("leaves out days older than the week, and says when there is nothing to split", async () => {
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 1 }],
      domains: [{ domain: "example.com", activeMs: 30 * MIN, pageVisits: 1 }],
      categories: [day("2026-09-25", 60, 30, 30)],
    };
    mount("/");
    expect(await screen.findByText(/no time to split yet/i)).toBeTruthy();
  });

  it("counts a goal streak across days, including a quiet day, and stops at an over day", async () => {
    backend.goals?.push({ category: "distracting", minutes: 60 });
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 1 }],
      domains: [{ domain: "example.com", activeMs: 30 * MIN, pageVisits: 1 }],
      categories: [
        day("2026-10-16", 10, 0, 30),
        day("2026-10-17", 10, 0, 90),
        day("2026-10-18", 10, 0, 50),
        // 2026-10-19 has no activity: a kept day.
        day("2026-10-20", 10, 0, 20),
      ],
    };
    mount("/");
    expect((await screen.findByTestId("streak-distracting")).textContent).toBe("Streak: 3 days");
    expect(screen.getByText(/Distracting today: 20m of 1h 00m/)).toBeTruthy();
  });

  it("drops the streak and says so when today is over the goal", async () => {
    backend.goals?.push({ category: "distracting", minutes: 30 });
    backend.activity = {
      days: [{ date: "2026-10-20", activeMs: 30 * MIN, pageVisits: 1 }],
      domains: [{ domain: "example.com", activeMs: 30 * MIN, pageVisits: 1 }],
      categories: [day("2026-10-19", 10, 0, 10), day("2026-10-20", 10, 0, 45)],
    };
    mount("/");
    expect((await screen.findByTestId("streak-distracting")).textContent).toBe("Streak: 0 days");
    expect(screen.getByText(/over the goal/)).toBeTruthy();
  });
});

describe("weekly summary page", () => {
  const thisFrom = () => daysWindow(NOW, ZONE, 7).from;
  const lastFrom = () => daysWindow(NOW, ZONE, 7, 7).from;

  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/summary");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows an empty state without activity", async () => {
    mount("/summary");
    expect(await screen.findByText(/no activity in the last 14 days/i)).toBeTruthy();
  });

  it("compares the weeks, and shows goals, limits kept and the biggest changes", async () => {
    backend.goals?.push({ category: "distracting", minutes: 60 });
    backend.limits = [
      {
        id: "0192f1c2-7c1e-7a3b-9f00-0000000000b1",
        pattern: "youtube.com",
        minutes: 30,
        strict: false,
      },
      {
        id: "0192f1c2-7c1e-7a3b-9f00-0000000000b2",
        pattern: "*.reddit.com",
        minutes: 5,
        strict: false,
      },
    ];
    backend.activity = {
      days: [],
      domains: [],
      categories: [
        day("2026-10-08", 100, 20, 80),
        day("2026-10-12", 0, 0, 40),
        day("2026-10-15", 60, 10, 30),
        day("2026-10-18", 50, 0, 70),
        day("2026-10-20", 30, 10, 20),
      ],
      domainsByFrom: {
        [thisFrom()]: [
          { domain: "github.com", activeMs: 140 * MIN, pageVisits: 1 },
          { domain: "youtube.com", activeMs: 120 * MIN, pageVisits: 1 },
        ],
        [lastFrom()]: [
          { domain: "youtube.com", activeMs: 200 * MIN, pageVisits: 1 },
          { domain: "github.com", activeMs: 100 * MIN, pageVisits: 1 },
          { domain: "reddit.com", activeMs: 30 * MIN, pageVisits: 1 },
        ],
      },
      site: {
        days: [
          { date: "2026-10-19", activeMs: 45 * MIN, pageVisits: 1 },
          { date: "2026-10-20", activeMs: 20 * MIN, pageVisits: 1 },
        ],
      },
    };
    mount("/summary");
    // This week 140m productive, 20m neutral, 120m distracting; last week 100 / 20 / 120.
    expect((await screen.findByTestId("this-productiveMs")).textContent).toBe("2h 20m");
    expect(screen.getByTestId("this-total").textContent).toBe("4h 40m");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("row", { name: /productive/i }).textContent).toMatch(/\+40m/);
    expect(within(table).getByRole("row", { name: /all sites/i }).textContent).toMatch(
      /4h 40m.*4h 00m.*\+40m/,
    );
    // 6 of 7 days at or under 1h of distracting time; the 18th was over; the streak is 20th, 19th.
    expect(screen.getByTestId("goal-distracting").textContent).toMatch(
      /kept 6 of 7 days\. Streak: 2 days/,
    );
    // youtube.com: 6 of 7 days under 30 minutes (the 19th was 45); the wildcard limit is not counted.
    expect(screen.getByTestId("limits-kept").textContent).toMatch(/6 of 7 limit days/);
    expect(screen.getByText(/1 limit on a group of subdomains/)).toBeTruthy();
    const changes = screen.getByRole("list", { name: "Sites that changed the most" });
    const rows = within(changes).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^youtube\.com-1h 20m \(3h 20m to 2h 00m\)$/),
      expect.stringMatching(/^github\.com\+40m \(1h 40m to 2h 20m\)$/),
      expect.stringMatching(/^reddit\.com-30m \(30m to 0m\)$/),
    ]);
  });

  it("says when there are no goals or limits", async () => {
    backend.activity = {
      days: [],
      domains: [],
      categories: [day("2026-10-20", 30, 10, 20)],
    };
    backend.limits = [];
    mount("/summary");
    expect(await screen.findByText(/no goals or limits yet/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set a goal" }).getAttribute("href")).toBe(
      "/categories",
    );
  });

  it("shows an error when the summary cannot be loaded", async () => {
    delete backend.activity;
    mount("/summary", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load your summary/i)).toBeTruthy();
  });
});
