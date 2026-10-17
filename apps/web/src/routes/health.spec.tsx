import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

function buckets(count: number, last: Partial<Record<string, number>> = {}) {
  return Array.from({ length: count }, (_, i) => ({
    bucket: new Date(Date.UTC(2026, 9, 17, 0, 0, 0) + i * 3_600_000).toISOString(),
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    rejected: 0,
    ...(i === count - 1 ? last : {}),
  }));
}

const LAPTOP = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Work laptop",
  kind: "browser-extension",
  status: "active",
  lastSeenAt: "2026-10-17T10:00:00.000Z",
  heartbeat: {
    queueDepth: 42,
    oldestQueuedAgeMs: 125_000,
    droppedCount: 3,
    clientVersion: "0.1.0",
  },
};

beforeEach(() => {
  backend = makeBackend({ authed: true });
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

describe("health page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/health");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows last seen and heartbeat queue health per source", async () => {
    backend.diagnostics = { integrations: [LAPTOP], ingestion: buckets(24) };
    mount("/health");
    const card = (await screen.findByText("Work laptop")).closest("li") as HTMLElement;
    expect(within(card).getByText("42")).toBeTruthy();
    expect(within(card).getByText("2m")).toBeTruthy();
    expect(within(card).getByText("0.1.0")).toBeTruthy();
    expect(within(card).getByText(/last seen/i).textContent).not.toMatch(/never/i);
  });

  it("says so when a source has not sent a heartbeat or been seen", async () => {
    backend.diagnostics = {
      integrations: [{ ...LAPTOP, lastSeenAt: null, heartbeat: null }],
      ingestion: buckets(24),
    };
    mount("/health");
    expect(await screen.findByText(/no heartbeat received yet/i)).toBeTruthy();
    expect(screen.getByText(/last seen: never/i)).toBeTruthy();
  });

  it("charts accepted, duplicate, dropped and rejected totals for the window", async () => {
    backend.diagnostics = {
      integrations: [],
      ingestion: buckets(24, { accepted: 10, duplicate: 2, dropped: 3, rejected: 1 }),
    };
    mount("/health");
    expect(await screen.findByRole("img", { name: /last 24 hours/i })).toBeTruthy();
    for (const [label, n] of [
      ["Accepted", "10"],
      ["Duplicate", "2"],
      ["Dropped", "3"],
      ["Rejected", "1"],
    ] as const) {
      const item = screen.getByText(`${label}:`).closest("li") as HTMLElement;
      expect(within(item).getByText(n)).toBeTruthy();
    }
    expect(screen.queryByText(/no events received/i)).toBeNull();
  });

  it("shows empty states", async () => {
    backend.diagnostics = { integrations: [], ingestion: buckets(24) };
    mount("/health");
    expect(await screen.findByText(/no sources yet/i)).toBeTruthy();
    expect(screen.getByText(/no events received in this window/i)).toBeTruthy();
  });

  it("shows an error when loading fails", async () => {
    mount("/health", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect((await screen.findByText(/could not load diagnostics/i)).getAttribute("role")).toBe(
      "alert",
    );
  });
});
