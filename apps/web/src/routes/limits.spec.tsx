import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

const YOUTUBE = {
  id: "0192f1c2-7c1e-7a3b-9f00-0000000000a1",
  pattern: "youtube.com",
  minutes: 60,
  strict: false,
};
const REDDIT = {
  id: "0192f1c2-7c1e-7a3b-9f00-0000000000a2",
  pattern: "*.reddit.com",
  minutes: 20,
  strict: true,
};

let backend: FakeBackend;

beforeEach(() => {
  backend = makeBackend({ authed: true, limits: [] });
  installFetch(backend);
});
afterEach(cleanup);

const writes = () => backend.calls.filter((c) => ["POST", "PUT", "DELETE"].includes(c.method));

function fill(site: string, minutes: string) {
  fireEvent.change(screen.getByLabelText("Site"), { target: { value: site } });
  fireEvent.change(screen.getByLabelText("Minutes per day"), { target: { value: minutes } });
}

describe("limits page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/limits");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("is reachable from the navigation", async () => {
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Limits" }).getAttribute("href")).toBe("/limits");
  });

  it("shows an empty state, and says the extension counts on the device", async () => {
    mount("/limits");
    expect(await screen.findByText(/no limits yet/i)).toBeTruthy();
    expect(screen.getByText(/counted on your device/i)).toBeTruthy();
    expect(screen.getByText(/only sites your rules collect/i)).toBeTruthy();
  });

  it("shows a loading state, then the saved limits", async () => {
    backend.limits?.push(YOUTUBE, REDDIT);
    // Hold the list request, so the loading state can be seen.
    const real = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/limits") && (init?.method ?? "GET") === "GET") await gate;
      return real(input, init);
    }) as typeof fetch;
    mount("/limits");
    expect(await screen.findByText(/loading/i)).toBeTruthy();
    release();
    expect(await screen.findByText("youtube.com")).toBeTruthy();
    expect(screen.getByText("*.reddit.com")).toBeTruthy();
    expect(screen.getByLabelText("Minutes per day for youtube.com")).toHaveProperty("value", "60");
    expect(screen.getByLabelText("Strict mode for *.reddit.com")).toHaveProperty("checked", true);
  });

  it("shows an error when the limits cannot be loaded", async () => {
    delete backend.limits;
    mount("/limits", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText(/could not load limits/i)).toBeTruthy();
  });

  it("adds a limit, lowercasing the site, and lists it", async () => {
    mount("/limits");
    await screen.findByText(/no limits yet/i);
    fill("  YouTube.com ", "45");
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    expect(await screen.findByText("youtube.com")).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      body: { pattern: "youtube.com", minutes: 45, strict: false },
    });
  });

  it("adds a strict limit when the box is ticked", async () => {
    mount("/limits");
    await screen.findByText(/no limits yet/i);
    fill("*.reddit.com", "20");
    fireEvent.click(screen.getByLabelText(/strict mode \(no extra time/i));
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ pattern: "*.reddit.com", strict: true });
  });

  it.each([
    ["a url", "https://youtube.com/watch", "30"],
    ["no minutes", "youtube.com", ""],
    ["zero minutes", "youtube.com", "0"],
    ["more than a day", "youtube.com", "1441"],
  ])("does not send %s", async (_label, site, minutes) => {
    mount("/limits");
    await screen.findByText(/no limits yet/i);
    fill(site, minutes);
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(writes()).toHaveLength(0);
  });

  it("explains a site that already has a limit", async () => {
    backend.limits?.push(YOUTUBE);
    mount("/limits");
    await screen.findByText("youtube.com");
    fill("youtube.com", "10");
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    expect(await screen.findByText(/already a limit for that site/i)).toBeTruthy();
  });

  it("saves a changed number of minutes and strict mode", async () => {
    backend.limits?.push(YOUTUBE);
    mount("/limits");
    const minutes = await screen.findByLabelText("Minutes per day for youtube.com");
    fireEvent.change(minutes, { target: { value: "90" } });
    fireEvent.click(screen.getByLabelText("Strict mode for youtube.com"));
    fireEvent.click(screen.getByRole("button", { name: "Save youtube.com" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: `/v1/limits/${YOUTUBE.id}`,
      body: { pattern: "youtube.com", minutes: 90, strict: true },
    });
  });

  it("removes a limit", async () => {
    backend.limits?.push(YOUTUBE, REDDIT);
    mount("/limits");
    await screen.findByText("youtube.com");
    fireEvent.click(screen.getByRole("button", { name: "Remove youtube.com" }));
    await waitFor(() => expect(screen.queryByText("youtube.com")).toBeNull());
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/v1/limits/${YOUTUBE.id}` });
    expect(screen.getByText("*.reddit.com")).toBeTruthy();
  });
});
