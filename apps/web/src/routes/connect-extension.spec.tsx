import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  fillAndSubmit,
  installFetch,
  makeBackend,
  mount,
  PAIRING_CODE,
  PASSWORD,
  pathname,
  USER,
} from "@/test/auth-harness";

// M8-01 one-click connect, dashboard side: `/connect-extension` (after login if needed) creates a
// browser-extension integration and a pairing code only when the user confirms, then moves to
// `/connect-extension/done#code=<code>`, where the extension's background reads it.

let backend: FakeBackend;
const logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  backend = makeBackend({ integrations: [] });
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

const posts = (path: string) => backend.calls.filter((c) => c.method === "POST" && c.path === path);
const CONNECT = /connect this browser/i;
type Router = ReturnType<typeof mount>["router"];
const settle = (r: Router, expected: string) => waitFor(() => expect(pathname(r)).toBe(expected));

describe("/connect-extension", () => {
  it("sends a signed-out user to login, then back to the connect page", async () => {
    const { router } = mount("/connect-extension");
    await settle(router, "/login");
    expect(router.state.location.search).toEqual({ redirect: "/connect-extension" });
    await fillAndSubmit({ email: USER.email, password: PASSWORD }, /sign in/i);
    await settle(router, "/connect-extension");
    expect(await screen.findByRole("button", { name: CONNECT })).toBeTruthy();
  });

  it("keeps the way back through first-run setup", async () => {
    backend.needsSetup = true;
    const { router } = mount("/connect-extension");
    await settle(router, "/setup");
    expect(router.state.location.search).toEqual({ redirect: "/connect-extension" });
    await fillAndSubmit({ name: "Admin", email: USER.email, password: PASSWORD }, /create/i);
    await settle(router, "/connect-extension");
  });

  it("keeps the way back when the user follows the sign-up link", async () => {
    const { router } = mount("/login?redirect=%2Fconnect-extension");
    fireEvent.click(await screen.findByRole("link", { name: /sign up/i }));
    await settle(router, "/signup");
    expect(router.state.location.search).toEqual({ redirect: "/connect-extension" });
    await fillAndSubmit({ name: "Alice", email: USER.email, password: PASSWORD }, /create/i);
    await settle(router, "/connect-extension");
  });

  it.each(["//evil.com", "https://evil.com/connect-extension", "/\\evil.com"])(
    "ignores an external redirect (%s) and goes home after login",
    async (target) => {
      const { router } = mount(`/login?redirect=${encodeURIComponent(target)}`);
      await fillAndSubmit({ email: USER.email, password: PASSWORD }, /sign in/i);
      await settle(router, "/");
    },
  );

  it("creates nothing until the user confirms", async () => {
    backend.authed = true;
    mount("/connect-extension");
    await screen.findByRole("button", { name: CONNECT });
    expect(posts("/v1/integrations")).toHaveLength(0);
    expect(backend.calls.some((c) => c.path.endsWith("/pairing-code"))).toBe(false);
  });

  it("on confirm, creates an extension integration and a code, then moves to the done page", async () => {
    backend.authed = true;
    const { router, queryClient } = mount("/connect-extension");
    fireEvent.click(await screen.findByRole("button", { name: CONNECT }));
    await settle(router, "/connect-extension/done");
    expect(router.state.location.hash).toBe(`code=${PAIRING_CODE}`);

    const [created] = posts("/v1/integrations");
    expect(created?.body).toMatchObject({ kind: "browser-extension" });
    expect(Object.keys(created?.body as object).sort()).toEqual(["kind", "name"]);
    const id = backend.integrations?.[0]?.id;
    expect(posts(`/v1/integrations/${id}/pairing-code`)).toHaveLength(1);

    // The code stays out of React Query's caches (they outlive the page).
    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ]);
    expect(cached).not.toContain(PAIRING_CODE);
  });

  it("shows an error and stays when the code cannot be issued", async () => {
    backend.authed = true;
    delete backend.integrations; // the fake answers 404
    const { router } = mount("/connect-extension");
    fireEvent.click(await screen.findByRole("button", { name: CONNECT }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(pathname(router)).toBe("/connect-extension");
  });
});

describe("/connect-extension/done", () => {
  it("says the tab closes by itself and offers the code to type in as a fallback", async () => {
    backend.authed = true;
    mount(`/connect-extension/done#code=${PAIRING_CODE}`);
    expect(await screen.findByText(/closes by itself/i)).toBeTruthy();
    expect(screen.getByText(PAIRING_CODE)).toBeTruthy();
  });

  it("shows no code when the fragment holds none, or something that is not a code", async () => {
    backend.authed = true;
    mount("/connect-extension/done#code=<b>x</b>");
    expect(await screen.findByText(/start again from the extension/i)).toBeTruthy();
    expect(screen.queryByText("<b>x</b>")).toBeNull();
  });
});
