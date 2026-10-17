import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type FakeBackend,
  type FakeIntegration,
  INGEST_KEY,
  installFetch,
  makeBackend,
  mount,
  PAIRING_CODE,
  pathname,
} from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

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
  backend = makeBackend({ authed: true, integrations: [] });
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

function mutationData(queryClient: QueryClient): string {
  return JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state.data),
  );
}

async function addIntegration(name: string, kind: RegExp) {
  fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: name } });
  fireEvent.click(screen.getByLabelText(kind));
  fireEvent.click(screen.getByRole("button", { name: /add integration/i }));
}

describe("integrations page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/integrations");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("lists the user's integrations", async () => {
    backend.integrations = [
      integration({ name: "Work laptop", kind: "browser-extension" }),
      integration({ name: "Old script", status: "revoked" }),
    ];
    mount("/integrations");
    expect(await screen.findByText("Work laptop")).toBeTruthy();
    expect(screen.getByText("Old script")).toBeTruthy();
    expect(screen.getByText(/revoked/i)).toBeTruthy();
    // A revoked source offers no actions.
    expect(screen.queryByRole("button", { name: /revoke old script/i })).toBeNull();
  });

  it("shows an empty state", async () => {
    mount("/integrations");
    expect(await screen.findByText(/no integrations yet/i)).toBeTruthy();
  });

  it("adds an extension and shows its pairing code with a countdown", async () => {
    mount("/integrations");
    await addIntegration("My Edge", /browser extension/i);
    expect((await screen.findByTestId("pairing-code")).textContent).toBe(PAIRING_CODE);
    expect(screen.getByRole("timer").textContent).toMatch(/10:00|9:5\d/);
    expect(await screen.findByRole("button", { name: /revoke my edge/i })).toBeTruthy();
    const posts = backend.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts[0]).toBe("/v1/integrations");
    expect(posts[1]).toMatch(/^\/v1\/integrations\/.+\/pairing-code$/);
    // The request names no user.
    expect(
      backend.calls.find((c) => c.method === "POST" && c.path === "/v1/integrations")?.body,
    ).toEqual({
      kind: "browser-extension",
      name: "My Edge",
    });
  });

  it("counts down and says when the code has expired", async () => {
    backend.codeTtlMs = 1500;
    mount("/integrations");
    await addIntegration("Short", /browser extension/i);
    await screen.findByTestId("pairing-code");
    expect(screen.getByRole("timer").textContent).toMatch(/0:0[12]/);
    expect(await screen.findByText(/expired/i, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId("pairing-code")).toBeNull();
  });

  it("issues a fresh code on demand", async () => {
    backend.integrations = [integration({ name: "Laptop", kind: "browser-extension" })];
    mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /pairing code for laptop/i }));
    expect((await screen.findByTestId("pairing-code")).textContent).toBe(PAIRING_CODE);
    fireEvent.click(screen.getByRole("button", { name: /new code/i }));
    await waitFor(() =>
      expect(backend.calls.filter((c) => c.path.endsWith("/pairing-code"))).toHaveLength(2),
    );
  });

  it("shows an HTTP integration's key once, then drops it", async () => {
    const { queryClient } = mount("/integrations");
    await addIntegration("Script", /http/i);
    expect((await screen.findByTestId("ingest-key")).textContent).toBe(INGEST_KEY);
    // Never kept in the query cache.
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(INGEST_KEY);
    expect(mutationData(queryClient)).not.toContain(INGEST_KEY);
    fireEvent.click(screen.getByRole("button", { name: /i have copied it/i }));
    expect(screen.queryByTestId("ingest-key")).toBeNull();
    expect(document.body.textContent).not.toContain(INGEST_KEY);
    // Nor left behind in the mutation cache once the panel is closed.
    await waitFor(() => expect(mutationData(queryClient)).not.toContain(INGEST_KEY));
  });

  it("drops the pairing code from the mutation cache when the panel is closed", async () => {
    backend.integrations = [integration({ name: "Laptop", kind: "browser-extension" })];
    const { queryClient } = mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /pairing code for laptop/i }));
    await screen.findByTestId("pairing-code");
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByTestId("pairing-code")).toBeNull();
    await waitFor(() => expect(mutationData(queryClient)).not.toContain(PAIRING_CODE));
  });

  it("drops a revoked integration's pairing code from the mutation cache", async () => {
    backend.integrations = [integration({ name: "Laptop", kind: "browser-extension" })];
    const { queryClient } = mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /pairing code for laptop/i }));
    await screen.findByTestId("pairing-code");
    fireEvent.click(screen.getByRole("button", { name: /^revoke laptop/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm revoke/i }));
    await waitFor(() => expect(screen.queryByTestId("pairing-code")).toBeNull());
    await waitFor(() => expect(mutationData(queryClient)).not.toContain(PAIRING_CODE));
  });

  it("counts down from the server's clock, not the browser's", async () => {
    // The browser runs 5 minutes ahead of the server: a fresh 10-minute code still shows ~10:00.
    const realNow = Date.now;
    backend.serverNow = realNow;
    const skew = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 60 * 1000);
    onTestFinished(() => skew.mockRestore());
    backend.integrations = [integration({ name: "Laptop", kind: "browser-extension" })];
    mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /pairing code for laptop/i }));
    await screen.findByTestId("pairing-code");
    expect(screen.getByRole("timer").textContent).toMatch(/10:00|9:5\d/);
  });

  it("rejects an empty name without calling the API", async () => {
    mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /add integration/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(backend.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("asks for confirmation before revoking, and cancel revokes nothing", async () => {
    backend.integrations = [integration({ name: "Script" })];
    mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /^revoke script/i }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(backend.calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(backend.calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
  });

  it("revokes after confirmation and shows the new status", async () => {
    backend.integrations = [integration({ name: "Script" })];
    mount("/integrations");
    fireEvent.click(await screen.findByRole("button", { name: /^revoke script/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm revoke/i }));
    expect(await screen.findByText(/· revoked/i)).toBeTruthy();
    expect(backend.calls.filter((c) => c.path.endsWith("/revoke"))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^revoke script/i })).toBeNull();
  });

  it("never logs a secret", async () => {
    mount("/integrations");
    await addIntegration("Script", /http/i);
    await screen.findByTestId("ingest-key");
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
