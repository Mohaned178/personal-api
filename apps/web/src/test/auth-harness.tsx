import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { createAppRouter } from "@/router";

/**
 * Fake backend for the auth pages. Contract assumed from docs/PLAN.md section 6 and
 * apps/api/src/modules/auth: GET /v1/me (200 user | 401), Better Auth under /api/auth/*,
 * and GET /v1/setup/status ({ needsSetup, signupOpen }), the public first-run probe (see the report).
 */
export interface FakeBackend {
  authed: boolean;
  needsSetup: boolean;
  signupOpen: boolean;
  /** When true, GET /v1/me rejects with a network error. */
  meNetworkError?: boolean;
  /** Override sign-in / sign-up outcomes with an error status. */
  signInStatus?: number | undefined;
  signUpStatus?: number | undefined;
  calls: { method: string; path: string; body: unknown }[];
}

export const USER = { id: "u1", email: "alice@example.test", name: "Alice" };
export const PASSWORD = "correct-horse-battery";

export function makeBackend(init: Partial<FakeBackend> = {}): FakeBackend {
  return { authed: false, needsSetup: false, signupOpen: true, calls: [], ...init };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

export function installFetch(b: FakeBackend) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : (req?.url ?? ""),
      "http://localhost",
    );
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    let body: unknown;
    const raw = init?.body ?? (req ? await req.clone().text() : undefined);
    if (typeof raw === "string" && raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    b.calls.push({ method, path: url.pathname, body });
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me":
        if (b.meNetworkError) throw new TypeError("network down");
        return b.authed ? json(200, USER) : json(401, { code: "auth.unauthenticated" });
      case "GET /v1/setup/status":
        return json(200, { needsSetup: b.needsSetup, signupOpen: b.signupOpen });
      case "POST /api/auth/sign-in/email":
        if (b.signInStatus && b.signInStatus >= 400)
          return json(b.signInStatus, { code: "INVALID_EMAIL_OR_PASSWORD" });
        b.authed = true;
        return json(200, { user: USER });
      case "POST /api/auth/sign-up/email":
        if (b.signUpStatus && b.signUpStatus >= 400)
          return json(b.signUpStatus, { code: "auth.signup_disabled" });
        b.authed = true;
        b.needsSetup = false;
        return json(200, { user: USER });
      case "POST /api/auth/sign-out":
        b.authed = false;
        return json(200, { success: true });
      default:
        return json(404, { code: "not_found" });
    }
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function mount(path: string, queryClient = new QueryClient()) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...utils };
}

export const pathname = (r: { state: { location: { pathname: string } } }) =>
  r.state.location.pathname;

/** Types into labelled inputs (matched case-insensitively) and clicks the submit button. */
export async function fillAndSubmit(fields: Record<string, string>, button: RegExp) {
  for (const [label, value] of Object.entries(fields)) {
    const input = await screen.findByLabelText(new RegExp(label, "i"));
    fireEvent.change(input, { target: { value } });
  }
  fireEvent.click(await screen.findByRole("button", { name: button }));
}
