import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

const WORK = {
  id: "0192f1c2-7c1e-7a3b-9f00-0000000000b1",
  name: "Work hours",
  patterns: ["reddit.com", "*.youtube.com"],
  days: [0, 1, 2, 3, 4],
  start: "09:00",
  end: "17:00",
  enabled: true,
};

let backend: FakeBackend;

beforeEach(() => {
  window.localStorage.setItem("personal-api.welcome-done", "1");
  backend = makeBackend({ authed: true, focus: null, schedules: [] });
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const writes = () => backend.calls.filter((c) => ["POST", "PUT", "DELETE"].includes(c.method));

describe("focus page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/focus");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("is reachable from the navigation", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Focus" }).getAttribute("href")).toBe("/focus");
  });

  it("shows the empty states and says the extension enforces them on the device", async () => {
    mount("/focus");
    expect(await screen.findByText(/no schedules yet/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Start focus session" })).toBeTruthy();
    expect(screen.getByText(/enforces both on your device/i)).toBeTruthy();
  });

  it("shows loading, then the saved schedules", async () => {
    backend.schedules?.push(WORK);
    // Hold the list request, so the loading state can be seen.
    const real = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/schedules") && (init?.method ?? "GET") === "GET") await gate;
      return real(input, init);
    }) as typeof fetch;
    mount("/focus");
    expect((await screen.findAllByText(/loading/i)).length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText("Work hours")).toBeTruthy();
    expect(screen.getByText(/09:00 to 17:00 · Mon, Tue, Wed, Thu, Fri/)).toBeTruthy();
    expect(screen.getByText("reddit.com, *.youtube.com")).toBeTruthy();
  });

  it("says so when the lists cannot load", async () => {
    delete backend.focus;
    delete backend.schedules;
    mount("/focus", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load schedules/i)).toBeTruthy();
    expect(await screen.findByText(/could not load focus mode/i)).toBeTruthy();
  });
});

describe("focus session", () => {
  it("starts a session for the sites and minutes, and shows it running with its end", async () => {
    mount("/focus");
    fireEvent.change(await screen.findByLabelText("Sites to block", { selector: "#focus-sites" }), {
      target: { value: "YouTube.com, *.reddit.com" },
    });
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Start focus session" }));
    const running = await screen.findByTestId("focus-running");
    expect(within(running).getByText(/focus mode is on until/i)).toBeTruthy();
    expect(within(running).getByText(/youtube\.com, \*\.reddit\.com/)).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual({ patterns: ["youtube.com", "*.reddit.com"], minutes: 30 });
  });

  it("refuses bad input without calling the server, and does not repeat what was typed", async () => {
    mount("/focus");
    const sites = await screen.findByLabelText("Sites to block", { selector: "#focus-sites" });
    fireEvent.change(sites, { target: { value: "https://secret.example/path?q=1" } });
    fireEvent.click(screen.getByRole("button", { name: "Start focus session" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/enter up to 20 sites/i);
    expect(alert.textContent).not.toContain("secret");
    fireEvent.change(sites, { target: { value: "youtube.com" } });
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Start focus session" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/between 1 and 480/i);
    expect(writes()).toEqual([]);
  });

  it("ends the running session", async () => {
    backend.focus = {
      id: "0192f1c2-7c1e-7a3b-9f00-0000000000f1",
      patterns: ["youtube.com"],
      endsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    };
    mount("/focus");
    fireEvent.click(await screen.findByRole("button", { name: "End focus session" }));
    expect(await screen.findByRole("button", { name: "Start focus session" })).toBeTruthy();
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("does not show a session whose end has passed as running", async () => {
    backend.focus = {
      id: "0192f1c2-7c1e-7a3b-9f00-0000000000f1",
      patterns: ["youtube.com"],
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    };
    mount("/focus");
    expect(await screen.findByRole("button", { name: "Start focus session" })).toBeTruthy();
    expect(screen.queryByTestId("focus-running")).toBeNull();
  });
});

describe("schedules", () => {
  function fillSchedule(name: string, sites: string) {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("Sites to block", { selector: "#schedule-sites" }), {
      target: { value: sites },
    });
  }

  it("adds a schedule with the chosen days and times", async () => {
    mount("/focus");
    await screen.findByText(/no schedules yet/i);
    fillSchedule("Night", "reddit.com");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23:00" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "07:00" } });
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect(await screen.findByText("Night")).toBeTruthy();
    expect(writes()[0]?.body).toEqual({
      name: "Night",
      patterns: ["reddit.com"],
      days: [0, 1, 2, 3, 4, 5],
      start: "23:00",
      end: "07:00",
      enabled: true,
    });
    expect(screen.getByText(/23:00 to 07:00 · Mon, Tue, Wed, Thu, Fri, Sat/)).toBeTruthy();
  });

  it.each([
    ["no name", "", "reddit.com", "09:00", "17:00", /give it a name/i],
    ["equal times", "Work", "reddit.com", "09:00", "09:00", /different start and end/i],
    ["a bad site", "Work", "not a site!", "09:00", "17:00", /enter up to 20 sites/i],
  ])("refuses %s without calling the server", async (_n, name, sites, from, until, message) => {
    mount("/focus");
    await screen.findByText(/no schedules yet/i);
    fillSchedule(name, sites);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: until } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(writes()).toEqual([]);
  });

  it("needs at least one day", async () => {
    mount("/focus");
    await screen.findByText(/no schedules yet/i);
    fillSchedule("Work", "reddit.com");
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      fireEvent.click(screen.getByLabelText(day));
    }
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /at least one site and one day/i,
    );
    expect(writes()).toEqual([]);
  });

  it("turns a schedule off and on, keeping the rest of it", async () => {
    backend.schedules?.push(WORK);
    mount("/focus");
    const toggle = await screen.findByLabelText("Turn on Work hours");
    fireEvent.click(toggle);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const { id, ...rest } = WORK;
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: `/v1/schedules/${id}`,
      body: { ...rest, enabled: false },
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Turn on Work hours") as HTMLInputElement).checked).toBe(false),
    );
  });

  it("removes a schedule", async () => {
    backend.schedules?.push(WORK);
    mount("/focus");
    fireEvent.click(await screen.findByRole("button", { name: "Remove Work hours" }));
    expect(await screen.findByText(/no schedules yet/i)).toBeTruthy();
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
  });
});
