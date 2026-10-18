import { rm } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import { sleep } from "../support/spike";
import {
  type FirefoxTab,
  type LaunchedFirefoxSpike,
  launchFirefoxSpike,
} from "../support/spike-firefox";

// Spike C (M2-00b): the Spike A design (ADR 0002, option B) re-run on a Firefox MV3 EVENT PAGE.
// Mirrors tests/spike-mv3.spec.ts scenario by scenario. The harness (Selenium + geckodriver, not
// Playwright: Playwright's Firefox cannot load extensions) is the contract documented at the top
// of support/spike-firefox.ts. Run with `pnpm --filter @personal-api/e2e test:e2e:firefox:spike`
// (playwright.firefox.config.ts; `test:e2e` does not run this file).
//
// Idle (60 s) and screen lock cannot be driven headless and Firefox may never report `locked`;
// they follow a manual protocol and are not covered here.
//
// Differences from the Chromium spec that are deliberate:
//   - the background is SUSPENDED, not killed, and a suspended Firefox event page keeps its
//     listeners, so events are expected to be DELIVERED after the wake (the Chromium spike measured
//     the opposite for events handed to a dying worker). The assertions are identical: no visit
//     lost, none duplicated.
//   - every state read goes through `LaunchedFirefoxSpike`, which must not create events itself.

const DOMAIN = "127.0.0.1";
const SEGMENT_CAP_MS = 30 * 60 * 1000;
/** The done-when says "off by less than 2 s". Stay clearly inside it. */
const TOLERANCE_MS = 1_500;
const SUSPENSIONS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Suspend, then start again without any browser event (nothing but the explicit start runs). */
async function suspendAndRestart(spike: LaunchedFirefoxSpike): Promise<void> {
  await spike.suspendBackground();
  expect(await spike.isBackgroundRunning()).toBe(false);
  await spike.startBackground();
  expect(await spike.isBackgroundRunning()).toBe(true);
}

/** Two tabs of the fixture site, `a` showing /a and `b` showing /b, with `b` active. */
async function openTwoTabs(
  spike: LaunchedFirefoxSpike,
  origin: string,
): Promise<{ a: FirefoxTab; b: FirefoxTab }> {
  const a = await spike.openTab(`${origin}/a`);
  const b = await spike.openTab(`${origin}/b`);
  return { a, b };
}

test.describe("Spike C: Firefox event page state persistence", () => {
  test("loses and duplicates no captured events across 20 forced background suspensions", async ({
    site,
  }) => {
    test.setTimeout(600_000);
    const spike = await launchFirefoxSpike();
    try {
      await spike.clear();
      const tab = await spike.openTab("about:blank");

      // Never two identical consecutive URLs. One of them carries a query + fragment that must not
      // be stored (invariant 3).
      const urls = [
        { url: `${site.origin}/a`, path: "/a" },
        { url: `${site.origin}/b?q=secret#frag`, path: "/b" },
        { url: `${site.origin}/`, path: "/" },
      ];
      const expectedPaths: string[] = [];
      let nav = 0;
      const nextTarget = (): { url: string; path: string } => {
        const target = urls[nav++ % urls.length];
        if (!target) throw new Error("unreachable");
        expectedPaths.push(target.path);
        return target;
      };
      const visit = async (): Promise<void> => {
        await spike.navigate(tab, nextTarget().url);
      };
      const settle = async (): Promise<void> => {
        await expect
          .poll(async () => (await spike.pageVisits()).length, { timeout: 10_000 })
          .toBe(expectedPaths.length);
      };

      const bootIds = [await spike.bootId()];
      for (let round = 0; round < SUSPENSIONS; round++) {
        if (round % 4 === 0) {
          // Settled suspension: the event is already queued, then the page is suspended.
          await visit();
          await settle();
          await suspendAndRestart(spike);
        } else if (round % 4 === 1) {
          // Mid-burst: suspended right after a burst of navigations, with no waiting for the queue
          // to catch up, then more events arrive.
          await visit();
          await visit();
          await suspendAndRestart(spike);
          await visit();
        } else if (round % 4 === 2) {
          // The event itself must wake a suspended page (top-level listeners), with no explicit
          // start.
          await spike.suspendBackground();
          expect(await spike.isBackgroundRunning()).toBe(false);
          await visit();
          await spike.waitForBackground();
        } else {
          // Suspend with a navigation still loading: the navigation is not awaited before it.
          await visit();
          await spike.navigate(tab, nextTarget().url, { wait: false });
          await spike.suspendBackground();
          await spike.waitForLoad(tab);
          // The navigation's own events may already have woken the page; starting it is then a no-op.
          await spike.startBackground();
        }
        bootIds.push(await spike.bootId());
      }
      await visit();
      await settle();

      // Every suspension really restarted the page: 1 initial boot + 20 restarts, all distinct.
      expect(bootIds).toHaveLength(SUSPENSIONS + 1);
      expect(new Set(bootIds).size).toBe(bootIds.length);

      const visits = await spike.pageVisits();
      // Zero lost: the queue holds exactly the navigations that were made, in order.
      expect(visits.map((v) => v.path)).toEqual(expectedPaths);
      // Zero duplicated: one distinct uuid per navigation.
      expect(new Set(visits.map((v) => v.id)).size).toBe(visits.length);
      for (const v of visits) {
        expect(v.id).toMatch(UUID);
        expect(v.domain).toBe(DOMAIN);
        expect(Number.isFinite(v.ts)).toBe(true);
      }
      // Nothing from the query string or fragment reached the queue.
      expect(JSON.stringify(await spike.queueDump())).not.toMatch(/secret|frag|\?q=/);
    } finally {
      await spike.close();
    }
  });

  test("adds no visit and duplicates nothing when a suspended background is started without any event", async ({
    site,
  }) => {
    const spike = await launchFirefoxSpike();
    try {
      await spike.clear();
      const tab = await spike.openTab(`${site.origin}/a`);
      await spike.navigate(tab, `${site.origin}/b`);
      await expect.poll(async () => (await spike.pageVisits()).length).toBe(2);
      const before = (await spike.pageVisits()).map((v) => v.id);
      const bootBefore = await spike.bootId();

      // Worker-start reconciliation must not re-emit pages that were already recorded.
      for (let i = 0; i < 3; i++) await suspendAndRestart(spike);
      await sleep(1_000);

      expect(await spike.bootId()).not.toBe(bootBefore);
      expect((await spike.pageVisits()).map((v) => v.id)).toEqual(before);
    } finally {
      await spike.close();
    }
  });

  test("reads state without creating events, tabs or segments of its own", async ({ site }) => {
    const spike = await launchFirefoxSpike();
    try {
      await spike.clear();
      await spike.openTab(`${site.origin}/a`);
      await expect.poll(async () => (await spike.pageVisits()).length).toBe(1);
      const first = await spike.queueDump();
      await sleep(500);
      await spike.segments();
      await spike.bootId();
      const second = await spike.queueDump();
      expect(second.filter((e) => e.type === "page_visited")).toHaveLength(1);
      // Observation never added a queue entry (focus segments from the page staying in front are
      // closed ones only and none is due without a focus change).
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    } finally {
      await spike.close();
    }
  });

  test("reports the window of an activated tab as focused and an unfocused window after a blur", async ({
    site,
  }) => {
    const spike = await launchFirefoxSpike();
    try {
      const { a } = await openTwoTabs(spike, site.origin);
      await spike.activate(a);
      // The level-triggered focus check of the design depends on this flag.
      await expect.poll(() => spike.windowFocused(), { timeout: 5_000 }).toBe(true);
      await spike.blurWindow();
      await expect.poll(() => spike.windowFocused(), { timeout: 5_000 }).toBe(false);
    } finally {
      await spike.close();
    }
  });

  test("measures tab-switch and blur segments within 2 s of the scripted durations", async ({
    site,
  }) => {
    test.setTimeout(120_000);
    const spike = await launchFirefoxSpike();
    try {
      const { a, b } = await openTwoTabs(spike, site.origin);
      // Forget the setup navigations: from here only the scripted focus timeline is measured.
      await spike.clear();

      // /a is in front for ~3 s.
      await spike.activate(a);
      const aShown = Date.now();
      await sleep(3_000);

      // Switch to /b for ~3 s, with the background suspended and restarted while that segment is
      // still open.
      await spike.activate(b);
      const bShown = Date.now();
      await sleep(1_500);
      await suspendAndRestart(spike);
      await sleep(1_500);

      // Then the window loses focus.
      await spike.blurWindow();
      const blurred = Date.now();

      await expect.poll(async () => (await spike.segments()).length).toBe(2);
      const segments = await spike.segments();
      const [segA, segB] = segments;
      if (!segA || !segB) throw new Error("expected two closed segments");

      expect([segA.domain, segA.path]).toEqual([DOMAIN, "/a"]);
      expect([segB.domain, segB.path]).toEqual([DOMAIN, "/b"]);

      // Each duration matches what the script did, within the 2 s budget (tolerance 1.5 s).
      expect(Math.abs(segA.durationMs - (bShown - aShown))).toBeLessThan(TOLERANCE_MS);
      expect(Math.abs(segB.durationMs - (blurred - bShown))).toBeLessThan(TOLERANCE_MS);
      // The segment that spans the suspension is whole, not split or truncated at it.
      expect(segB.durationMs).toBeGreaterThanOrEqual(3_000 - TOLERANCE_MS);

      for (const segment of segments) {
        expect(segment.durationMs).toBe(segment.endedAt - segment.startedAt);
        expect(segment.durationMs).toBeGreaterThan(0);
        expect(segment.durationMs).toBeLessThanOrEqual(SEGMENT_CAP_MS);
      }
      // Back to back: /a ends when /b starts, no gap and no overlap beyond the tolerance.
      expect(Math.abs(segB.startedAt - segA.endedAt)).toBeLessThan(TOLERANCE_MS);
      expect(segB.startedAt).toBeGreaterThanOrEqual(segA.startedAt);
    } finally {
      await spike.close();
    }
  });

  test("closes a segment correctly when the tab switch arrives while the background is suspended", async ({
    site,
  }) => {
    test.setTimeout(120_000);
    const spike = await launchFirefoxSpike();
    try {
      const { a, b } = await openTwoTabs(spike, site.origin);
      await spike.clear();

      await spike.activate(a);
      const aShown = Date.now();
      await sleep(2_000);
      await spike.suspendBackground();
      expect(await spike.isBackgroundRunning()).toBe(false);
      await sleep(1_000);

      // The tab switch is the event that wakes the page: the open /a segment is only in storage.
      await spike.activate(b);
      const bShown = Date.now();
      await spike.waitForBackground();
      await sleep(1_500);
      await spike.blurWindow();
      const blurred = Date.now();

      await expect.poll(async () => (await spike.segments()).length).toBe(2);
      const [segA, segB] = await spike.segments();
      if (!segA || !segB) throw new Error("expected two closed segments");

      expect(segA.path).toBe("/a");
      expect(Math.abs(segA.durationMs - (bShown - aShown))).toBeLessThan(TOLERANCE_MS);
      expect(segB.path).toBe("/b");
      expect(Math.abs(segB.durationMs - (blurred - bShown))).toBeLessThan(TOLERANCE_MS);
    } finally {
      await spike.close();
    }
  });

  test("keeps the queue and closes the open segment, without inflating it, across a browser restart", async ({
    site,
  }) => {
    test.setTimeout(180_000);
    const first = await launchFirefoxSpike();
    try {
      await first.clear();
      const tab = await first.openTab("about:blank");

      // Three navigations; the last one (/a) is still in front, so its segment is OPEN at close.
      await first.navigate(tab, `${site.origin}/a`);
      await first.navigate(tab, `${site.origin}/b`);
      await first.navigate(tab, `${site.origin}/a`);
      const lastShown = Date.now();
      await sleep(2_000);
      await expect.poll(async () => (await first.pageVisits()).length).toBe(3);

      const before = await first.queueDump();
      const beforeBootId = await first.bootId();
      const closedBefore = await first.segments();
      const closedAt = Date.now();
      await first.close({ keepProfile: true });

      // The browser stays down for a while. That time must never become attention time.
      await sleep(4_000);

      const second = await launchFirefoxSpike({ userDataDir: first.userDataDir });
      try {
        // Same add-on id and pinned uuid: the relaunch sees the same IndexedDB.
        expect(second.extensionUuid).toBe(first.extensionUuid);
        await second.waitForBackground();
        expect(await second.bootId()).not.toBe(beforeBootId);

        // Nothing queued before the restart is lost or duplicated, and the restart added no visit.
        const after = await second.queueDump();
        expect(after.map((e) => e.id)).toEqual(expect.arrayContaining(before.map((e) => e.id)));
        expect(new Set(after.map((e) => e.id)).size).toBe(after.length);
        expect((await second.pageVisits()).map((v) => v.path)).toEqual(["/a", "/b", "/a"]);

        // The segment that was open at close is now closed: recovered, not dropped.
        await expect
          .poll(async () => (await second.segments()).length, { timeout: 15_000 })
          .toBe(closedBefore.length + 1);
        const segments = await second.segments();
        const recovered = segments[segments.length - 1];
        if (!recovered) throw new Error("expected a recovered segment");
        expect([recovered.domain, recovered.path]).toEqual([DOMAIN, "/a"]);
        expect(recovered.durationMs).toBe(recovered.endedAt - recovered.startedAt);
        expect(recovered.durationMs).toBeGreaterThanOrEqual(0);
        expect(recovered.durationMs).toBeLessThanOrEqual(SEGMENT_CAP_MS);
        // It started when /a was shown and ended no later than the browser close: the 4 s the
        // browser was down are not counted. Slack covers event-vs-test clock skew only.
        expect(Math.abs(recovered.startedAt - lastShown)).toBeLessThan(TOLERANCE_MS);
        expect(recovered.endedAt).toBeLessThanOrEqual(closedAt + TOLERANCE_MS);
        expect(recovered.durationMs).toBeLessThanOrEqual(closedAt - lastShown + TOLERANCE_MS);
      } finally {
        await second.close({ keepProfile: true });
      }
    } finally {
      await rm(first.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
