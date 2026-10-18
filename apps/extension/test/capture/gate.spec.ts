import { describe, expect, it } from "vitest";
import type { CaptureGate } from "../../lib/capture";
import {
  advance,
  allowAll,
  allowDomains,
  denyAll,
  newSim,
  type Sim,
  setupSimTests,
  T0,
} from "./support/sim";

// M2-04: the rule gate. Deny by default and fail closed (invariants 1 and 2; ADR 0002 decision 8):
// when the gate denies, throws, rejects or answers anything but `true`, nothing is emitted and no
// domain or path is stored, on every emission path. Pause is a gate that denies.

setupSimTests();

const DENIED_PAGES = ["https://secret.test/private/area", "https://other.test/x"];

async function browseEverything(sim: Sim): Promise<void> {
  await sim.start();
  await sim.navigate(sim.tabId, DENIED_PAGES[0] as string);
  advance(5000);
  const second = await sim.openTab();
  await sim.navigate(second, DENIED_PAGES[1] as string);
  advance(5000);
  await sim.beats(3);
  await sim.setIdle("idle");
  await sim.setIdle("active");
  await sim.setIdle("locked");
  await sim.setIdle("active");
  await sim.blur();
  await sim.closeTab(second);
}

const THROWING_GATES: [string, CaptureGate][] = [
  ["denies", denyAll],
  [
    "throws",
    {
      allows: () => {
        throw new Error("rules unreadable");
      },
    },
  ],
  ["rejects", { allows: () => Promise.reject(new Error("rules unreadable")) }],
  ["answers the string 'yes'", { allows: () => "yes" as unknown as boolean }],
  ["answers 1", { allows: () => 1 as unknown as boolean }],
  ["answers undefined", { allows: () => undefined as unknown as boolean }],
];

describe("a gate that does not say true collects nothing", () => {
  it.each(THROWING_GATES)(
    "a gate that %s: no event of any type, no domain or path stored",
    async (_name, gate) => {
      const sim = newSim({ gate });
      await browseEverything(sim);
      expect(sim.queue).toEqual([]);
      const dump = sim.store.dump();
      for (const leak of ["secret.test", "other.test", "/private"]) {
        expect(dump).not.toContain(leak);
      }
    },
  );

  it("collects again as soon as the gate allows (positive control)", async () => {
    const sim = newSim({ gate: denyAll });
    await browseEverything(sim);
    expect(sim.queue).toEqual([]);
    sim.gate = allowAll;
    const tabId = await sim.openTab();
    await sim.navigate(tabId, "https://ok.test/now");
    expect(sim.visits().map((v) => v.domain)).toEqual(["ok.test"]);
  });

  it("lets every engine promise resolve to undefined even when the gate throws", async () => {
    const sim = newSim({
      gate: {
        allows: () => {
          throw new Error("boom");
        },
      },
    });
    await expect(sim.start()).resolves.toBeUndefined();
    sim.browser.mustTab(sim.tabId).url = "https://a.test/x";
    await expect(sim.update(sim.tabId, { status: "complete" })).resolves.toBeUndefined();
    await expect(sim.heartbeat()).resolves.toBeUndefined();
  });
});

describe("a gate that allows only some pages lets through only those", () => {
  it("emits page_visited and focus_segment for allowed domains only, and stores nothing about the others", async () => {
    const sim = newSim({ gate: allowDomains(["a.test"]) });
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/one");
    advance(2000);
    await sim.navigate(sim.tabId, "https://denied.test/hidden/page");
    advance(3000);
    await sim.navigate(sim.tabId, "https://a.test/two");
    advance(4000);
    await sim.blur();
    expect(sim.visits().map((v) => `${v.domain}${v.path}`)).toEqual(["a.test/one", "a.test/two"]);
    expect(sim.segments().map((s) => [s.domain, s.path, s.durationMs])).toEqual([
      ["a.test", "/one", 2000],
      ["a.test", "/two", 4000],
    ]);
    expect(sim.store.dump()).not.toMatch(/denied\.test|hidden/);
  });

  it("asks the gate with the sanitized page, never with a query or fragment", async () => {
    const asked: unknown[] = [];
    const sim = newSim({
      gate: {
        allows: (page) => {
          asked.push(page);
          return true;
        },
      },
    });
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/p?token=s3cr3t#frag");
    await sim.beats(1);
    const pages = asked.filter((page) => page !== null);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).toEqual({ domain: "a.test", path: "/p" });
    expect(JSON.stringify(asked)).not.toMatch(/s3cr3t|frag|token/);
  });

  it("does not ask the gate about incognito or unsupported pages", async () => {
    const asked: unknown[] = [];
    const sim = newSim({
      gate: {
        allows: (page) => {
          asked.push(page);
          return true;
        },
      },
    });
    await sim.start();
    const incognito = await sim.openTab({ incognito: true });
    await sim.navigate(incognito, "https://private.example/secret");
    await sim.navigate(sim.tabId, "chrome://settings");
    await sim.beats(1);
    expect(JSON.stringify(asked)).not.toMatch(/private\.example|settings/);
  });
});

describe("pausing (a gate that starts denying) stops collection and never extends a segment", () => {
  it("closes the segment that was open and starts a fresh one when collection resumes", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/page");
    await sim.beats(1); // 30 s
    sim.gate = denyAll;
    await sim.beats(1); // 60 s: paused, the segment must not stay open
    sim.gate = allowAll;
    await sim.beats(1); // 90 s: resumed
    advance(5000);
    await sim.blur(); // 95 s
    const segments = sim.segments();
    // Paused between the 30 s and the 60 s step, resumed at the 90 s step. Whatever was emitted
    // for the first stretch ends by the step that saw the deny, and nothing bridges the pause.
    for (const s of segments) {
      expect(s.endedAt <= T0 + 60_000 || s.startedAt >= T0 + 90_000).toBe(true);
    }
    const resumed = segments.filter((s) => s.startedAt >= T0 + 90_000);
    expect(resumed.map((s) => [s.startedAt - T0, s.endedAt - T0])).toEqual([[90_000, 95_000]]);
  });

  it("emits no page_visited while denied, and one after the gate allows again", async () => {
    const sim = newSim();
    await sim.start();
    sim.gate = denyAll;
    await sim.navigate(sim.tabId, "https://a.test/paused");
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    sim.gate = allowAll;
    await sim.navigate(sim.tabId, "https://a.test/resumed");
    expect(sim.visits().map((v) => v.path)).toEqual(["/resumed"]);
  });
});
