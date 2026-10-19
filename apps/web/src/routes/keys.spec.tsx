import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  type FakeIntegration,
  type FakeReadKey,
  installFetch,
  makeBackend,
  mount,
  pathname,
  READ_KEY,
} from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

function readKey(over: Partial<FakeReadKey>): FakeReadKey {
  return {
    id: crypto.randomUUID(),
    name: null,
    prefix: "pa_read_abcdef",
    scopes: ["events:read"],
    restriction: null,
    createdAt: "2026-10-18T10:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

function integration(over: Partial<FakeIntegration>): FakeIntegration {
  return {
    id: crypto.randomUUID(),
    kind: "http",
    name: "Thing",
    defaultPolicy: "deny",
    status: "active",
    lastSeenAt: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  backend = makeBackend({ authed: true, integrations: [], readKeys: [] });
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

const postedKey = () => backend.calls.find((c) => c.method === "POST" && c.path === "/v1/keys");

describe("keys page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/keys");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows an empty state", async () => {
    mount("/keys");
    expect(await screen.findByText(/no read keys yet/i)).toBeTruthy();
  });

  it("lists keys with scopes, restriction, last use and status, never a secret", async () => {
    const source = integration({ name: "Work laptop" });
    backend.integrations = [source];
    backend.readKeys = [
      readKey({
        name: "Widget",
        scopes: ["events:read", "activity:read"],
        restriction: { sources: [source.id], types: ["browser.*"] },
        lastUsedAt: "2026-10-19T08:00:00.000Z",
      }),
      readKey({ name: "Old", revokedAt: "2026-10-18T12:00:00.000Z" }),
      readKey({ name: null, prefix: "pa_read_zzzzzz" }),
    ];
    mount("/keys");
    const widget = (await screen.findByText("Widget")).closest("li") as HTMLElement;
    expect(within(widget).getByText(/events:read/)).toBeTruthy();
    expect(within(widget).getByText(/activity:read/)).toBeTruthy();
    expect(within(widget).getByText(/browser\.\*/)).toBeTruthy();
    expect(await within(widget).findByText(/work laptop/i)).toBeTruthy();

    const old = screen.getByText("Old").closest("li") as HTMLElement;
    expect(within(old).getByText(/revoked/i)).toBeTruthy();
    expect(within(old).queryByRole("button", { name: /revoke/i })).toBeNull();

    // An unnamed key is identified by its prefix.
    expect(screen.getByText(/pa_read_zzzzzz/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(READ_KEY);
  });

  it("creates a key with the chosen scopes and shows it once, then drops it", async () => {
    const { queryClient } = mount("/keys");
    fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: "  Widget " } });
    fireEvent.click(screen.getByLabelText(/events:read/i));
    fireEvent.click(screen.getByLabelText(/activity:read/i));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    expect((await screen.findByTestId("read-key")).textContent).toBe(READ_KEY);
    // The request names scopes and a name only: no user, no kind.
    expect(postedKey()?.body).toEqual({ name: "Widget", scopes: ["events:read", "activity:read"] });
    // Never kept in the query or mutation cache.
    expect(cacheContents(queryClient)).not.toContain(READ_KEY);

    fireEvent.click(screen.getByRole("button", { name: /i have copied it/i }));
    expect(screen.queryByTestId("read-key")).toBeNull();
    expect(document.body.textContent).not.toContain(READ_KEY);
    await waitFor(() => expect(cacheContents(queryClient)).not.toContain(READ_KEY));
    // The new key is in the list, by its prefix and name.
    expect(await screen.findByText("Widget")).toBeTruthy();
  });

  it("needs at least one scope and calls nothing without it", async () => {
    mount("/keys");
    fireEvent.click(await screen.findByRole("button", { name: /create key/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one scope/i);
    expect(postedKey()).toBeUndefined();
  });

  it("sends a restriction only when one is given, with trimmed types", async () => {
    const source = integration({ name: "Work laptop" });
    backend.integrations = [source];
    mount("/keys");
    fireEvent.click(await screen.findByLabelText(/events:read/i));
    fireEvent.click(await screen.findByLabelText(/work laptop/i));
    fireEvent.change(screen.getByLabelText(/event types/i), {
      target: { value: " browser.* , browser.page_visited ,, " },
    });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    await screen.findByTestId("read-key");
    expect(postedKey()?.body).toEqual({
      scopes: ["events:read"],
      restriction: { sources: [source.id], types: ["browser.*", "browser.page_visited"] },
    });
  });

  it("omits the restriction when nothing is restricted", async () => {
    mount("/keys");
    fireEvent.click(await screen.findByLabelText(/activity:read/i));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    await screen.findByTestId("read-key");
    expect(postedKey()?.body).toEqual({ scopes: ["activity:read"] });
  });

  it("says so when the server refuses, and shows no key", async () => {
    backend.rejectKeyCreate = 400;
    mount("/keys");
    fireEvent.click(await screen.findByLabelText(/events:read/i));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not create/i);
    expect(screen.queryByTestId("read-key")).toBeNull();
  });

  it("asks for confirmation before revoking, and cancel revokes nothing", async () => {
    backend.readKeys = [readKey({ name: "Widget" })];
    mount("/keys");
    fireEvent.click(await screen.findByRole("button", { name: /^revoke widget/i }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(backend.calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(backend.calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
  });

  it("revokes after confirmation and shows the new status", async () => {
    backend.readKeys = [readKey({ name: "Widget" })];
    mount("/keys");
    fireEvent.click(await screen.findByRole("button", { name: /^revoke widget/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm revoke/i }));
    expect(await screen.findByText(/· revoked/i)).toBeTruthy();
    expect(backend.calls.filter((c) => c.path.endsWith("/revoke"))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^revoke widget/i })).toBeNull();
  });

  it("never logs a secret", async () => {
    mount("/keys");
    fireEvent.click(await screen.findByLabelText(/events:read/i));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    await screen.findByTestId("read-key");
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
