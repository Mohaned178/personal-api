import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENDPOINT_KEY,
  type FakeBackend,
  type FakeEndpoint,
  installFetch,
  makeBackend,
  mount,
  pathname,
} from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

const definition = {
  when: { type: ["browser.page_visited"] },
  window: { kind: "last_n_days", days: 7 },
  aggregate: "count_by_day",
};

function endpoint(over: Partial<FakeEndpoint> = {}): FakeEndpoint {
  return {
    id: crypto.randomUUID(),
    slug: "stats",
    enabled: true,
    definition,
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  backend = makeBackend({ authed: true, endpoints: [] });
  installFetch(backend);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    logSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const s of logSpies.splice(0)) s.mockRestore();
});

function cacheContents(queryClient: QueryClient): string {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state.data),
  ]);
}

const calls = (method: string, path: string) =>
  backend.calls.filter((c) => c.method === method && c.path === path);

describe("endpoints page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/endpoints");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows an empty state", async () => {
    mount("/endpoints");
    expect(await screen.findByText(/no endpoints yet/i)).toBeTruthy();
  });

  it("lists endpoints with a copyable curl that holds no key", async () => {
    backend.endpoints = [endpoint({ slug: "stats" }), endpoint({ slug: "old", enabled: false })];
    mount("/endpoints");
    const row = (await screen.findByText("stats")).closest("li") as HTMLElement;
    expect(within(row).getByText(/\/v1\/me\/stats/).textContent).toContain("Bearer $PA_KEY");
    expect(within(row).getByText(/count_by_day/)).toBeTruthy();
    const old = screen.getByText("old").closest("li") as HTMLElement;
    expect(within(old).getByText(/disabled/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(ENDPOINT_KEY);
  });

  it("previews the definition live and shows the result", async () => {
    backend.previewResult = {
      kind: "count_by_day",
      rows: [{ date: "2026-10-19", count: 3 }],
      truncated: false,
    };
    mount("/endpoints");
    const preview = await screen.findByTestId("endpoint-preview");
    expect(preview.textContent).toContain('"count": 3');
    expect(calls("POST", "/v1/endpoints/preview")[0]?.body).toEqual({ definition });
  });

  it("waits for valid JSON instead of calling the preview", async () => {
    mount("/endpoints");
    await screen.findByTestId("endpoint-preview");
    const before = calls("POST", "/v1/endpoints/preview").length;
    fireEvent.change(screen.getByLabelText(/saved query/i), { target: { value: "{ nope" } });
    expect(await screen.findByText(/waiting for valid json/i)).toBeTruthy();
    expect(calls("POST", "/v1/endpoints/preview")).toHaveLength(before);
  });

  it("says so when the preview is refused", async () => {
    backend.rejectPreview = 400;
    mount("/endpoints");
    expect((await screen.findByRole("alert")).textContent).toMatch(/not valid/i);
  });

  it("creates an endpoint, shows the key and curl once, and keeps the key out of the cache", async () => {
    const { queryClient } = mount("/endpoints");
    fireEvent.change(await screen.findByLabelText(/^slug/i), { target: { value: " weekly " } });
    fireEvent.click(screen.getByRole("button", { name: /create endpoint/i }));

    expect((await screen.findByTestId("endpoint-key")).textContent).toBe(ENDPOINT_KEY);
    expect(screen.getByTestId("endpoint-curl").textContent).toContain(
      `Bearer ${ENDPOINT_KEY}" ${window.location.origin}/v1/me/weekly`,
    );
    expect(calls("POST", "/v1/endpoints")[0]?.body).toEqual({
      slug: "weekly",
      enabled: true,
      definition,
    });
    expect(cacheContents(queryClient)).not.toContain(ENDPOINT_KEY);

    fireEvent.click(screen.getByRole("button", { name: /i have copied it/i }));
    expect(screen.queryByTestId("endpoint-key")).toBeNull();
    expect(document.body.textContent).not.toContain(ENDPOINT_KEY);
    await waitFor(() => expect(cacheContents(queryClient)).not.toContain(ENDPOINT_KEY));
    expect(await screen.findByText("weekly")).toBeTruthy();
  });

  it("does not call the server when the definition is not JSON", async () => {
    mount("/endpoints");
    fireEvent.change(await screen.findByLabelText(/^slug/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/saved query/i), { target: { value: "{ nope" } });
    fireEvent.click(screen.getByRole("button", { name: /create endpoint/i }));
    expect((await screen.findByText(/not valid json/i)).getAttribute("role")).toBe("alert");
    expect(calls("POST", "/v1/endpoints")).toHaveLength(0);
  });

  it("says so when the slug is taken, and shows no key", async () => {
    backend.rejectEndpointSave = 409;
    mount("/endpoints");
    fireEvent.change(await screen.findByLabelText(/^slug/i), { target: { value: "stats" } });
    fireEvent.click(screen.getByRole("button", { name: /create endpoint/i }));
    expect(await screen.findByText(/already have an endpoint/i)).toBeTruthy();
    expect(screen.queryByTestId("endpoint-key")).toBeNull();
  });

  it("edits an endpoint with a PUT of the whole thing", async () => {
    const stored = endpoint({ slug: "stats" });
    backend.endpoints = [stored];
    mount("/endpoints");
    fireEvent.click(await screen.findByRole("button", { name: /^edit stats/i }));
    fireEvent.click(await screen.findByLabelText(/enabled/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(calls("PUT", `/v1/endpoints/${stored.id}`)).toHaveLength(1));
    expect(calls("PUT", `/v1/endpoints/${stored.id}`)[0]?.body).toEqual({
      slug: "stats",
      enabled: false,
      definition,
    });
  });

  it("asks before rotating, then shows the new key once", async () => {
    const stored = endpoint();
    backend.endpoints = [stored];
    const { queryClient } = mount("/endpoints");
    fireEvent.click(await screen.findByRole("button", { name: /rotate key of stats/i }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(calls("POST", `/v1/endpoints/${stored.id}/rotate-key`)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /confirm new key/i }));
    expect((await screen.findByTestId("endpoint-key")).textContent).toBe(ENDPOINT_KEY);
    expect(cacheContents(queryClient)).not.toContain(ENDPOINT_KEY);
  });

  it("deletes only after confirmation, and cancel deletes nothing", async () => {
    const stored = endpoint();
    backend.endpoints = [stored];
    mount("/endpoints");
    fireEvent.click(await screen.findByRole("button", { name: /^delete stats/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(calls("DELETE", `/v1/endpoints/${stored.id}`)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^delete stats/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm delete/i }));
    await waitFor(() => expect(calls("DELETE", `/v1/endpoints/${stored.id}`)).toHaveLength(1));
    expect(await screen.findByText(/no endpoints yet/i)).toBeTruthy();
  });

  it("never logs a secret", async () => {
    mount("/endpoints");
    fireEvent.change(await screen.findByLabelText(/^slug/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /create endpoint/i }));
    await screen.findByTestId("endpoint-key");
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
