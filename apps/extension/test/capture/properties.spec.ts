import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { sanitizeUrl } from "../../lib/sanitize-url";
import { advance, allowDomains, assertQueueValid, Sim, setupSimTests, T0 } from "./support/sim";

// M2-04 property tests (fast-check): whatever the user and the browser do, in whatever order, and
// however often the background is killed, the emitted events keep the invariants of PLAN §4 and
// of the privacy rules. Time only moves through `advance`, so every run is deterministic.

setupSimTests();

const URLS = [
  "https://a.test/one?x=1#f",
  "https://news.test/p/q?token=s3cr3t",
  "http://sub.example.org/",
  "https://a.test/enc%3Fy%23z",
  "https://xn--bcher-kva.example/%C3%BC?x",
  "https://denied.test/hidden/page?x=1",
  "chrome://settings",
  "about:blank",
  "file:///c:/x",
  "javascript:alert(1)",
];
const INCOGNITO_URL = "https://incog.test/priv?x=1#frag";
const LEAKS = ["incog.test", "/priv", "s3cr3t", "denied.test", "/hidden", "frag"];

type Op =
  | { k: "nav"; t: number; u: number }
  | { k: "open"; incog: boolean }
  | { k: "activate"; t: number }
  | { k: "focus" }
  | { k: "blur" }
  | { k: "idle" }
  | { k: "active" }
  | { k: "lock" }
  | { k: "beat" }
  | { k: "close"; t: number }
  | { k: "kill" }
  | { k: "restart" }
  | { k: "wait" };

const opArb: fc.Arbitrary<{ dt: number; op: Op }> = fc.record({
  dt: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 45_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 45_000, max: 3_600_000 }) },
  ),
  op: fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({ k: fc.constant("nav" as const), t: fc.nat(5), u: fc.nat(30) }),
    },
    { weight: 2, arbitrary: fc.record({ k: fc.constant("open" as const), incog: fc.boolean() }) },
    { weight: 3, arbitrary: fc.record({ k: fc.constant("activate" as const), t: fc.nat(5) }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "focus" }) },
    { weight: 3, arbitrary: fc.constant<Op>({ k: "blur" }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "idle" }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "active" }) },
    { weight: 1, arbitrary: fc.constant<Op>({ k: "lock" }) },
    { weight: 4, arbitrary: fc.constant<Op>({ k: "beat" }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant("close" as const), t: fc.nat(5) }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "kill" }) },
    { weight: 1, arbitrary: fc.constant<Op>({ k: "restart" }) },
    { weight: 1, arbitrary: fc.constant<Op>({ k: "wait" }) },
  ),
});

async function play(sim: Sim, script: { dt: number; op: Op }[]): Promise<void> {
  await sim.start();
  const tabs = [sim.tabId];
  const incognito = new Set<number>();
  const live = (index: number): number | undefined => {
    const candidates = tabs.filter((id) => sim.browser.tabs.has(id));
    return candidates.length === 0 ? undefined : candidates[index % candidates.length];
  };
  for (const { dt, op } of script) {
    advance(dt);
    switch (op.k) {
      case "nav": {
        const id = live(op.t);
        if (id !== undefined) {
          await sim.navigate(
            id,
            incognito.has(id) ? INCOGNITO_URL : (URLS[op.u % URLS.length] as string),
          );
        }
        break;
      }
      case "open": {
        const id = await sim.openTab({ incognito: op.incog });
        tabs.push(id);
        if (op.incog) incognito.add(id);
        break;
      }
      case "activate": {
        const id = live(op.t);
        if (id !== undefined) await sim.activate(id);
        break;
      }
      case "focus":
        await sim.focusWindow(sim.windowId);
        break;
      case "blur":
        await sim.blur();
        break;
      case "idle":
        await sim.setIdle("idle");
        break;
      case "active":
        await sim.setIdle("active");
        break;
      case "lock":
        await sim.setIdle("locked");
        break;
      case "beat":
        await sim.heartbeat();
        break;
      case "close": {
        const id = live(op.t);
        if (id !== undefined) await sim.closeTab(id);
        break;
      }
      case "kill":
        sim.restartWorker();
        await sim.start();
        break;
      case "restart":
        sim.restartWorker({ browserSession: true });
        await sim.start();
        break;
      case "wait":
        break;
    }
  }
}

describe("capture invariants hold for any sequence of browser events", () => {
  it("emits only valid, private, non-overlapping, capped, alternating events", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), async (script) => {
        vi.setSystemTime(T0);
        const sim = new Sim({ gate: allowDomains(["a.test", "news.test", "sub.example.org"]) });
        await play(sim, script);
        const elapsedMs = Date.now() - T0;

        // Contract: every event parses, ids are unique, no path carries ? or #.
        assertQueueValid(sim);

        // Privacy: incognito pages, denied domains, query values and fragments never appear.
        const dump = sim.store.dump();
        for (const leak of LEAKS) expect(dump).not.toContain(leak);

        // Segments: positive, capped, never overlapping, never more than the time that passed.
        const segments = sim.segments();
        for (const s of segments) {
          expect(s.durationMs).toBeGreaterThan(0);
          expect(s.durationMs).toBeLessThanOrEqual(FOCUS_SEGMENT_MAX_MS);
          expect(s.endedAt - s.startedAt).toBe(s.durationMs);
          expect(s.endedAt).toBeLessThanOrEqual(Date.now());
        }
        for (let i = 1; i < segments.length; i++) {
          expect(segments[i - 1]?.endedAt).toBeLessThanOrEqual(segments[i]?.startedAt ?? 0);
        }
        expect(segments.reduce((sum, s) => sum + s.durationMs, 0)).toBeLessThanOrEqual(elapsedMs);

        // Sessions: started and ended alternate, starting with started.
        const kinds = sim.sessionEvents().map((e) => e.kind);
        for (let i = 0; i < kinds.length; i++) {
          expect(kinds[i]).toBe(i % 2 === 0 ? "started" : "ended");
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe("URLs reach events only through the sanitizer", () => {
  it("for any URL, page_visited and focus_segment carry exactly the sanitizer's output, never ? or #", async () => {
    const urlArb = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc.webUrl({
        authoritySettings: { withUserInfo: true, withPort: true },
        withQueryParameters: true,
      }),
      fc.string({ maxLength: 60 }),
      fc.constantFrom(...URLS),
    );
    await fc.assert(
      fc.asyncProperty(urlArb, async (url) => {
        vi.setSystemTime(T0);
        const sim = new Sim();
        await sim.start();
        await sim.navigate(sim.tabId, url);
        advance(1000);
        await sim.blur();
        assertQueueValid(sim);
        const expected = sanitizeUrl(url);
        const visits = sim.visits().map(({ domain, path }) => ({ domain, path }));
        const segments = sim.segments().map(({ domain, path }) => ({ domain, path }));
        expect(visits).toEqual(expected ? [expected] : []);
        expect(segments).toEqual(expected ? [expected] : []);
        for (const event of sim.queue) {
          const path = (event.data as { path?: unknown }).path;
          if (typeof path === "string") expect(path).not.toMatch(/[?#]/);
        }
      }),
      { numRuns: 150 },
    );
  });
});
