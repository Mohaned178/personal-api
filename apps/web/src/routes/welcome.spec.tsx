import { allButSensitiveRules, chooseSitesRules, workSitesRules } from "@personal-api/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  type FakeIntegration,
  fillAndSubmit,
  installFetch,
  makeBackend,
  mount,
  PASSWORD,
  pathname,
  USER,
} from "@/test/auth-harness";
import { parseSites } from "./welcome-page";

// M8-02 setup wizard: `/welcome` after login while the user has no integration or no rule, a
// connect step that waits for the extension, a preset step that saves through POST /v1/rules,
// and a localStorage flag so it shows only once.

const extension = (lastSeenAt: string | null): FakeIntegration => ({
  id: crypto.randomUUID(),
  kind: "browser-extension",
  name: "Firefox",
  defaultPolicy: "deny",
  status: "active",
  lastSeenAt,
  createdAt: "2026-10-21T00:00:00.000Z",
});
const SEEN = "2026-10-21T09:00:00.000Z";
const someRule = { id: crypto.randomUUID(), name: "Mine", priority: 5 };

let backend: FakeBackend;
beforeEach(() => {
  window.localStorage.clear();
  backend = makeBackend({ authed: true, integrations: [], rules: { version: 0, rules: [] } });
  installFetch(backend);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Router = ReturnType<typeof mount>["router"];
const settle = (r: Router, expected: string) => waitFor(() => expect(pathname(r)).toBe(expected));
const rulePosts = () => backend.calls.filter((c) => c.method === "POST" && c.path === "/v1/rules");
const next = () => screen.findByRole("button", { name: /^next$/i });

async function toPresetStep() {
  backend.integrations = [extension(SEEN)];
  const { router } = mount("/welcome");
  const button = await next();
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText(/step 2 of 2/i);
  return router;
}

describe("when /welcome opens", () => {
  it("opens after login for a new user", async () => {
    backend.authed = false;
    const { router } = mount("/login");
    await fillAndSubmit({ email: USER.email, password: PASSWORD }, /sign in/i);
    await settle(router, "/welcome");
  });

  it.each([
    ["no integration", [], [someRule]],
    ["no rule", [extension(SEEN)], []],
  ])("opens from home with %s", async (_label, integrations, rules) => {
    backend.integrations = integrations;
    backend.rules = { version: 1, rules };
    const { router } = mount("/");
    await settle(router, "/welcome");
  });

  it("stays home for a user with an integration and a rule", async () => {
    backend.integrations = [extension(SEEN)];
    backend.rules = { version: 1, rules: [someRule] };
    const { router } = mount("/");
    await screen.findByRole("button", { name: /sign out/i });
    expect(pathname(router)).toBe("/");
  });

  it("a revoked integration does not count", async () => {
    backend.integrations = [{ ...extension(SEEN), status: "revoked" }];
    backend.rules = { version: 1, rules: [someRule] };
    const { router } = mount("/");
    await settle(router, "/welcome");
  });

  it("stays home when the checks fail", async () => {
    delete backend.integrations; // 404
    const { router } = mount("/");
    await screen.findByRole("button", { name: /sign out/i });
    expect(pathname(router)).toBe("/");
  });

  it("sends a signed-out user to login", async () => {
    backend.authed = false;
    const { router } = mount("/welcome");
    await settle(router, "/login");
  });
});

describe("shows only once", () => {
  it("skipping sets the flag, and neither home nor /welcome shows it again", async () => {
    const first = mount("/welcome");
    fireEvent.click(await screen.findByRole("button", { name: /skip setup/i }));
    await settle(first.router, "/");
    cleanup();

    const again = mount("/");
    await screen.findByRole("button", { name: /sign out/i });
    expect(pathname(again.router)).toBe("/");
    cleanup();

    const direct = mount("/welcome");
    await settle(direct.router, "/");
  });

  it("finishing sets the flag", async () => {
    const router = await toPresetStep();
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await settle(router, "/");
    expect(window.localStorage.getItem("personal-api.welcome-done")).toBe("1");
  });

  it("still opens home when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { router } = mount("/");
    await screen.findByRole("button", { name: /sign out/i });
    expect(pathname(router)).toBe("/");
    vi.restoreAllMocks();
  });
});

describe("step 1: connect", () => {
  it("shows this server's address and waits for the extension", async () => {
    mount("/welcome");
    expect(await screen.findByText(window.location.origin)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/waiting/i);
    expect(((await next()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a paired extension that has not reached the server yet still waits", async () => {
    backend.integrations = [extension(null)];
    mount("/welcome");
    await screen.findByText(/waiting/i);
    expect(((await next()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves on once the integration's lastSeenAt is set", async () => {
    const integration = extension(null);
    backend.integrations = [integration];
    mount("/welcome");
    await screen.findByText(/waiting/i);
    integration.lastSeenAt = SEEN; // the extension's first heartbeat
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/connected/i), {
      timeout: 5000,
    });
    expect(((await next()) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("step 2: presets", () => {
  it("saves every rule of the default preset through POST /v1/rules", async () => {
    const router = await toPresetStep();
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await settle(router, "/");
    expect(rulePosts().map((c) => c.body)).toEqual(allButSensitiveRules());
  });

  it("saves the work-sites rule", async () => {
    const router = await toPresetStep();
    fireEvent.click(screen.getByLabelText(/only work sites/i));
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await settle(router, "/");
    expect(rulePosts().map((c) => c.body)).toEqual(workSitesRules());
  });

  it("choose sites makes one allow rule from what the user typed", async () => {
    const router = await toPresetStep();
    fireEvent.click(screen.getByLabelText(/choose sites/i));
    fireEvent.change(screen.getByLabelText(/your sites/i), {
      target: { value: "https://www.Example.com/path, news.example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await settle(router, "/");
    expect(rulePosts().map((c) => c.body)).toEqual(
      chooseSitesRules(["example.com", "news.example.org"]),
    );
  });

  it("choose sites refuses an empty or invalid list and saves nothing", async () => {
    const router = await toPresetStep();
    fireEvent.click(screen.getByLabelText(/choose sites/i));
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/site names/i);
    fireEvent.change(screen.getByLabelText(/your sites/i), {
      target: { value: "not a domain!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await screen.findByRole("alert");
    expect(rulePosts()).toHaveLength(0);
    expect(pathname(router)).toBe("/welcome");
  });

  it("a failed save stays on the step, and the retry does not save a rule twice", async () => {
    const router = await toPresetStep();
    // Fail the third create.
    const real = globalThis.fetch;
    let creates = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input) === "/v1/rules" && ++creates === 3) {
        return new Response("{}", { status: 500 });
      }
      return real(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await screen.findByRole("alert");
    expect(pathname(router)).toBe("/welcome");

    fireEvent.click(screen.getByRole("button", { name: /save and finish/i }));
    await settle(router, "/");
    const names = (backend.rules?.rules ?? []).map((r) => r.name);
    expect(names).toEqual(allButSensitiveRules().map((r) => r.name));
  });

  it("says when the user already has rules", async () => {
    backend.rules = { version: 1, rules: [someRule] };
    await toPresetStep();
    expect(await screen.findByText(/already have 1 rule/i)).toBeTruthy();
  });
});

describe("parseSites", () => {
  it("keeps the host of what the user typed", () => {
    expect(parseSites(" HTTPS://www.Example.com/a?b#c,\nnews.example.org  docs.x.dev ")).toEqual([
      "example.com",
      "news.example.org",
      "docs.x.dev",
    ]);
  });
});
