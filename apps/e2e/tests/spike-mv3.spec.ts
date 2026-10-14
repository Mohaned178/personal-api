import { rm } from "node:fs/promises";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { killServiceWorker, startServiceWorker, waitForServiceWorker } from "../support/extension";
import { expect, test } from "../support/fixtures";
import {
  blurBrowserWindow,
  bootIdOf,
  clearSpike,
  closedSegments,
  type LaunchedSpike,
  launchSpike,
  pageVisits,
  queueDump,
  sleep,
} from "../support/spike";

// Spike A (M0-10): MV3 lifecycle under forced service-worker termination, tab switches, window
// blur and browser restart. The prototype under test lives in `spikes/mv3-lifecycle` and the
// contract between it and these tests is documented at the top of support/spike.ts.
//
// Idle (60 s) and screen lock cannot be driven headless: see docs/spikes/mv3-lifecycle-manual-protocol.md.

const DOMAIN = "127.0.0.1";
const SEGMENT_CAP_MS = 30 * 60 * 1000;
/** The done-when says "off by less than 2 s". Stay clearly inside it. */
const TOLERANCE_MS = 1_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Always start the worker with CDP, never with a popup tab: a tab would fire chrome.tabs events. */
async function killAndRestart(context: BrowserContext, extensionId: string): Promise<Worker> {
  await killServiceWorker(context);
  return startServiceWorker(context, extensionId);
}

/** Two tabs of the fixture site, `a` showing /a and `b` showing /b, with `b` active. */
async function openTwoTabs(
  extension: LaunchedSpike,
  origin: string,
): Promise<{ a: Page; b: Page }> {
  const a = extension.context.pages()[0] ?? (await extension.context.newPage());
  await a.goto(`${origin}/a`);
  const b = await extension.context.newPage();
  await b.goto(`${origin}/b`);
  return { a, b };
}

test.describe("Spike A: MV3 state persistence", () => {
  test("loses and duplicates no captured events across 20 forced service worker kills", async ({
    site,
  }) => {
    test.setTimeout(300_000);
    const spike = await launchSpike();
    try {
      let worker = await waitForServiceWorker(spike.context);
      await clearSpike(worker);
      const page = spike.context.pages()[0] ?? (await spike.context.newPage());

      // Never two identical consecutive URLs. One of them carries a query + fragment that must not
      // be stored (invariant 3).
      const urls = [
        { url: `${site.origin}/a`, path: "/a" },
        { url: `${site.origin}/b?q=secret#frag`, path: "/b" },
        { url: `${site.origin}/`, path: "/" },
      ];
      const expectedPaths: string[] = [];
      let nav = 0;
      const visit = async (): Promise<void> => {
        const target = urls[nav++ % urls.length];
        if (!target) throw new Error("unreachable");
        expectedPaths.push(target.path);
        await page.goto(target.url);
      };
      const settle = async (): Promise<void> => {
        await expect
          .poll(async () => (await pageVisits(worker)).length, { timeout: 10_000 })
          .toBe(expectedPaths.length);
      };

      const bootIds = [await bootIdOf(worker)];
      const KILLS = 20;
      for (let round = 0; round < KILLS; round++) {
        if (round % 4 === 0) {
          // Settled kill: the event is already queued, then the worker dies.
          await visit();
          await settle();
          worker = await killAndRestart(spike.context, spike.extensionId);
        } else if (round % 4 === 1) {
          // Mid-burst kill: the worker is killed right after a burst of navigations, with no
          // waiting for the queue to catch up, then more events arrive.
          await visit();
          await visit();
          worker = await killAndRestart(spike.context, spike.extensionId);
          await visit();
        } else if (round % 4 === 2) {
          // The event itself must wake a dead worker (top-level listeners), with no explicit start.
          await killServiceWorker(spike.context);
          await visit();
          worker = await waitForServiceWorker(spike.context);
        } else {
          // Kill with a navigation still loading: the goto is not awaited before the kill.
          await visit();
          const inFlight = visit();
          await killServiceWorker(spike.context);
          await inFlight;
          worker = await startServiceWorker(spike.context, spike.extensionId);
        }
        bootIds.push(await bootIdOf(worker));
      }
      await visit();
      await settle();

      // Every kill really restarted the worker: 1 initial boot + 20 restarts, all distinct.
      expect(new Set(bootIds).size).toBe(KILLS + 1);

      const visits = await pageVisits(worker);
      // Zero lost: the queue holds exactly the navigations that were made, in order.
      expect(visits.map((v) => v.path)).toEqual(expectedPaths);
      // Zero duplicated: one distinct uuid per navigation.
      expect(new Set(visits.map((v) => v.id)).size).toBe(visits.length);
      for (const visit of visits) {
        expect(visit.id).toMatch(UUID);
        expect(visit.domain).toBe(DOMAIN);
        expect(Number.isFinite(visit.ts)).toBe(true);
      }
      // Nothing from the query string or fragment reached the queue.
      expect(JSON.stringify(await queueDump(worker))).not.toMatch(/secret|frag|\?q=/);
    } finally {
      await spike.close();
    }
  });

  test("measures tab-switch and blur segments within 2 s of the scripted durations", async ({
    site,
  }) => {
    const spike = await launchSpike();
    try {
      let worker = await waitForServiceWorker(spike.context);
      const { a, b } = await openTwoTabs(spike, site.origin);
      // Forget the setup navigations: from here only the scripted focus timeline is measured.
      await clearSpike(worker);

      // /a is in front for ~3 s.
      await a.bringToFront();
      const aShown = Date.now();
      await sleep(3_000);

      // Switch to /b for ~3 s, with the worker killed while that segment is still open.
      const bShown = Date.now();
      await b.bringToFront();
      await sleep(1_500);
      worker = await killAndRestart(spike.context, spike.extensionId);
      await sleep(1_500);

      // Then the window loses focus.
      const blurred = Date.now();
      await blurBrowserWindow(worker);

      await expect.poll(async () => (await closedSegments(worker)).length).toBe(2);
      const segments = await closedSegments(worker);
      const [segA, segB] = segments;
      if (!segA || !segB) throw new Error("expected two closed segments");

      expect([segA.domain, segA.path]).toEqual([DOMAIN, "/a"]);
      expect([segB.domain, segB.path]).toEqual([DOMAIN, "/b"]);

      // Each duration matches what the script did, within the 2 s budget (tolerance 1.5 s).
      expect(Math.abs(segA.durationMs - (bShown - aShown))).toBeLessThan(TOLERANCE_MS);
      expect(Math.abs(segB.durationMs - (blurred - bShown))).toBeLessThan(TOLERANCE_MS);
      // The segment that spans the kill is whole, not split or truncated at the kill.
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

  test("closes a segment correctly when the tab switch arrives while the worker is dead", async ({
    site,
  }) => {
    const spike = await launchSpike();
    try {
      let worker = await waitForServiceWorker(spike.context);
      const { a, b } = await openTwoTabs(spike, site.origin);
      await clearSpike(worker);

      await a.bringToFront();
      const aShown = Date.now();
      await sleep(2_000);
      await killServiceWorker(spike.context);
      await sleep(1_000);

      // The tab switch is the event that wakes the worker: the open /a segment is only in storage.
      const bShown = Date.now();
      await b.bringToFront();
      worker = await waitForServiceWorker(spike.context);
      await sleep(1_500);
      const blurred = Date.now();
      await blurBrowserWindow(worker);

      await expect.poll(async () => (await closedSegments(worker)).length).toBe(2);
      const [segA, segB] = await closedSegments(worker);
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
    const first = await launchSpike();
    try {
      const firstWorker = await waitForServiceWorker(first.context);
      await clearSpike(firstWorker);
      const page = first.context.pages()[0] ?? (await first.context.newPage());

      // Three navigations; the last one (/a) is still in front, so its segment is OPEN at close.
      await page.goto(`${site.origin}/a`);
      await page.goto(`${site.origin}/b`);
      const lastShown = Date.now();
      await page.goto(`${site.origin}/a`);
      await sleep(2_000);
      await expect.poll(async () => (await pageVisits(firstWorker)).length).toBe(3);

      const before = await queueDump(firstWorker);
      const beforeBootId = await bootIdOf(firstWorker);
      const closedBefore = await closedSegments(firstWorker);
      const closedAt = Date.now();
      await first.close({ keepProfile: true });

      // The browser stays down for a while. That time must never become attention time.
      await sleep(4_000);

      const second = await launchSpike({ userDataDir: first.userDataDir });
      try {
        expect(second.extensionId).toBe(first.extensionId);
        const worker = await waitForServiceWorker(second.context);
        expect(await bootIdOf(worker)).not.toBe(beforeBootId);

        // Nothing queued before the restart is lost or duplicated, and the restart added no visit.
        const after = await queueDump(worker);
        expect(after.map((e) => e.id)).toEqual(expect.arrayContaining(before.map((e) => e.id)));
        expect(new Set(after.map((e) => e.id)).size).toBe(after.length);
        expect((await pageVisits(worker)).map((v) => v.path)).toEqual(["/a", "/b", "/a"]);

        // The segment that was open at close is now closed: recovered, not dropped.
        await expect
          .poll(async () => (await closedSegments(worker)).length, { timeout: 15_000 })
          .toBe(closedBefore.length + 1);
        const segments = await closedSegments(worker);
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
