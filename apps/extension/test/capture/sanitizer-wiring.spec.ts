import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advance, newSim, setupSimTests } from "./support/sim";

// M2-04 must sanitize every URL through the M2-03 sanitizer and use exactly what it returns
// (invariant 3). The sanitizer is replaced here, so an engine that parses URLs itself fails.

const sanitizeUrl = vi.hoisted(() => vi.fn());

vi.mock("../../lib/sanitize-url", () => ({
  MAX_URL_INPUT_LENGTH: 8192,
  sanitizeUrl,
}));

setupSimTests();

beforeEach(() => {
  sanitizeUrl.mockReset();
});
afterEach(() => {
  sanitizeUrl.mockReset();
});

describe("the engine uses the M2-03 sanitizer for every URL", () => {
  it("emits page_visited and focus_segment with exactly what the sanitizer returned", async () => {
    sanitizeUrl.mockImplementation((url: unknown) =>
      url === "https://real.example/real?x=1" ? { domain: "mocked.test", path: "/m" } : null,
    );
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://real.example/real?x=1");
    advance(1000);
    await sim.blur();
    expect(sim.segments().map(({ domain, path }) => ({ domain, path }))).toEqual([
      { domain: "mocked.test", path: "/m" },
    ]);
    expect(sim.visits().map(({ domain, path }) => ({ domain, path }))).toEqual([
      { domain: "mocked.test", path: "/m" },
    ]);
    expect(sim.store.dump()).not.toMatch(/real\.example/);
  });

  it("drops the visit and opens no segment when the sanitizer returns null, even for an http(s) URL", async () => {
    sanitizeUrl.mockReturnValue(null);
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://looks-fine.example/page");
    await sim.beats(2);
    await sim.blur();
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    expect(sim.ofType("browser.focus_segment")).toEqual([]);
    expect(sim.store.dump()).not.toMatch(/looks-fine/);
  });

  it("applies the sanitizer to a tab's URL on reconciliation too", async () => {
    sanitizeUrl.mockReturnValue(null);
    const sim = newSim();
    await sim.start();
    sim.browser.mustTab(sim.tabId).url = "https://looks-fine.example/lost";
    sim.restartWorker();
    await sim.start();
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    expect(sim.store.dump()).not.toMatch(/looks-fine/);
  });
});
