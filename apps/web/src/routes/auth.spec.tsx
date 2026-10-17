import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  fillAndSubmit,
  installFetch,
  makeBackend,
  mount,
  PASSWORD,
  pathname,
  USER,
} from "@/test/auth-harness";

const SIGN_IN = /sign in|log in/i;
const SIGN_UP = /create|sign up|register/i;
const SIGN_UP_LINK = /sign up|create account|register/i;

let backend: FakeBackend;
const logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  backend = makeBackend();
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
const settle = (r: Parameters<typeof pathname>[0], expected: string) =>
  waitFor(() => expect(pathname(r)).toBe(expected));

describe("route guards", () => {
  it("redirects an unauthenticated visitor from / to /login", async () => {
    const { router } = mount("/");
    await settle(router, "/login");
    expect(await screen.findByRole("button", { name: SIGN_IN })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("keeps an unauthenticated visitor on /login", async () => {
    const { router } = mount("/login");
    await screen.findByLabelText(/email/i);
    expect(pathname(router)).toBe("/login");
  });

  it.each(["/login", "/signup", "/setup"])(
    "redirects an authenticated user away from %s to /",
    async (path) => {
      backend.authed = true;
      const { router } = mount(path);
      await settle(router, "/");
      expect(await screen.findByRole("button", { name: /sign out/i })).toBeTruthy();
    },
  );

  it("shows the protected page to an authenticated user at /", async () => {
    backend.authed = true;
    const { router } = mount("/");
    expect(await screen.findByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(pathname(router)).toBe("/");
  });

  it("fails closed: an unreachable session check sends the visitor to /login, never the protected page", async () => {
    backend.meNetworkError = true;
    const { router } = mount("/");
    await settle(router, "/login");
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });
});

describe("first-run setup", () => {
  it("shows the setup form at /setup when no users exist", async () => {
    backend.needsSetup = true;
    const { router } = mount("/setup");
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
    expect(pathname(router)).toBe("/setup");
  });

  it("sends an unauthenticated visitor to /setup instead of /login when no users exist", async () => {
    backend.needsSetup = true;
    const { router } = mount("/");
    await settle(router, "/setup");
  });

  it("redirects /setup to /login once a user exists", async () => {
    backend.needsSetup = false;
    const { router } = mount("/setup");
    await settle(router, "/login");
  });

  it("creates the first account via Better Auth sign-up and lands on /", async () => {
    backend.needsSetup = true;
    const { router } = mount("/setup");
    await fillAndSubmit(
      { name: "Admin", email: USER.email, password: PASSWORD },
      /create|set up|continue|sign up/i,
    );
    await settle(router, "/");
    const [call] = posts("/api/auth/sign-up/email");
    expect(call?.body).toMatchObject({ email: USER.email, password: PASSWORD });
    expect(Object.keys(call?.body as object)).not.toContain("userId");
  });
});

describe("signup", () => {
  it("links to the signup form from /login when signups are open", async () => {
    backend.signupOpen = true;
    mount("/login");
    expect(await screen.findByRole("link", { name: SIGN_UP_LINK })).toBeTruthy();
  });

  it("creates an account and lands on / when signups are open", async () => {
    const { router } = mount("/signup");
    await fillAndSubmit({ name: "Alice", email: USER.email, password: PASSWORD }, SIGN_UP);
    await settle(router, "/");
    expect(posts("/api/auth/sign-up/email")).toHaveLength(1);
  });

  it("hides the signup link on /login when ALLOW_SIGNUP is false", async () => {
    backend.signupOpen = false;
    mount("/login");
    await screen.findByLabelText(/email/i);
    expect(screen.queryByRole("link", { name: SIGN_UP_LINK })).toBeNull();
  });

  it("blocks /signup by redirecting to /login when ALLOW_SIGNUP is false", async () => {
    backend.signupOpen = false;
    const { router } = mount("/signup");
    await settle(router, "/login");
    expect(posts("/api/auth/sign-up/email")).toHaveLength(0);
  });

  it("shows an error and stays put when the server refuses signup with auth.signup_disabled", async () => {
    backend.signupOpen = true; // stale client view: the server still refuses
    backend.signUpStatus = 403;
    const { router } = mount("/signup");
    await fillAndSubmit({ name: "Eve", email: "eve@example.test", password: PASSWORD }, SIGN_UP);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(pathname(router)).not.toBe("/");
  });

  it("does not send a signup request for a password shorter than 8 characters", async () => {
    mount("/signup");
    await fillAndSubmit({ name: "Alice", email: USER.email, password: "short" }, SIGN_UP);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(posts("/api/auth/sign-up/email")).toHaveLength(0);
  });
});

describe("login", () => {
  it("signs in with email and password and lands on /", async () => {
    const { router } = mount("/login");
    await fillAndSubmit({ email: USER.email, password: PASSWORD }, SIGN_IN);
    await settle(router, "/");
    const [call] = posts("/api/auth/sign-in/email");
    expect(call?.body).toMatchObject({ email: USER.email, password: PASSWORD });
  });

  it("shows an error and stays on /login for wrong credentials", async () => {
    backend.signInStatus = 401;
    const { router } = mount("/login");
    await fillAndSubmit({ email: USER.email, password: "wrong-password" }, SIGN_IN);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(pathname(router)).toBe("/login");
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("sends no request when the form is empty", async () => {
    mount("/login");
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN }));
    await screen.findByLabelText(/email/i);
    expect(posts("/api/auth/sign-in/email")).toHaveLength(0);
  });
});

describe("logout", () => {
  it("calls sign-out, redirects to /login and blocks / afterwards", async () => {
    backend.authed = true;
    const { router } = mount("/");
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));
    await settle(router, "/login");
    expect(posts("/api/auth/sign-out")).toHaveLength(1);
    expect(backend.authed).toBe(false);
    await router.navigate({ to: "/" });
    await settle(router, "/login");
  });

  it("clears the query cache on logout so the next user sees no stale data", async () => {
    backend.authed = true;
    const qc = new QueryClient();
    qc.setQueryData(["events"], [{ id: "secret" }]);
    const { router } = mount("/", qc);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));
    await settle(router, "/login");
    expect(qc.getQueryData(["events"])).toBeUndefined();
  });

  it("clears the query cache on sign-in, so an expired session's data never reaches the next user", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["events"], [{ id: "secret" }]);
    const { router } = mount("/login", qc);
    await fillAndSubmit({ email: USER.email, password: PASSWORD }, SIGN_IN);
    await settle(router, "/");
    expect(qc.getQueryData(["events"])).toBeUndefined();
  });
});

describe("logging", () => {
  it("never logs the email or password, on failed or successful sign-in", async () => {
    backend.signInStatus = 401;
    mount("/login");
    await fillAndSubmit({ email: USER.email, password: PASSWORD }, SIGN_IN);
    await screen.findByRole("alert");
    backend.signInStatus = undefined;
    fireEvent.click(screen.getByRole("button", { name: SIGN_IN }));
    await waitFor(() => expect(backend.authed).toBe(true));

    const logged = JSON.stringify(
      logSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String)),
    );
    expect(logged).not.toContain(USER.email);
    expect(logged).not.toContain(PASSWORD);
  });
});
