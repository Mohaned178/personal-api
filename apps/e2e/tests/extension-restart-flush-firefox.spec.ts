import { FIREFOX_EXTENSION_PATH, launchFirefoxExtension } from "../support/firefox";
import { expect, test } from "../support/fixtures";
import { startFlakyProxy } from "../support/flaky-proxy";
import {
  countByPath,
  pairThroughPopupFirefox,
  triggerFlushFirefox,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";

// M2-05 / M2-R gap, Firefox side: the event page is terminated in the MIDDLE of a flush, on the
// REAL build, 20 times. Same scenario and assertions as extension-restart-flush.spec.ts (Chromium):
// the proxy parks the in-flight ingest request before the API sees it (`hold-requests`) or after
// the API stored it (`hold-responses`), the event page is terminated with that request in flight,
// the browser cancels it, and in the end every visited path is in the database exactly once.
//
// How the event page is killed: `suspendBackground({ harsh: true })` calls Firefox's own
// `extension.terminateBackground()` (what the 30 s idle timer calls) and, unlike the default,
// does not wait for the pending listener promise. Without `harsh` Firefox declines to terminate
// while the flush's alarm listener promise is pending and the harness waits for the flush to end,
// which is the production behaviour. A kill mid-flush on Firefox therefore only happens for what
// `harsh` stands for: a crash, an extension update or reload, a browser quit. The page is gone at
// once and the in-flight request is cancelled, which is what this test needs.
//
// Needs `pnpm --filter extension build:firefox`, the built API, Firefox + geckodriver and Docker
// (or E2E_DATABASE_URL). Always runs in CI via `test:e2e`.

const ALLOWED_DOMAIN = "127.0.0.1";
const KILLS = 20;
const RECONNECT_TIMEOUT_MS = 120_000;

test("Firefox: 20 event page terminations while a flush is in flight lose nothing and store nothing twice", async ({
  stack,
  site,
}) => {
  test.setTimeout(600_000);
  const proxy = await startFlakyProxy(stack.apiOrigin);
  const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
    LOOPBACK_HOST_PERMISSION,
  ]);
  const firefox = await launchFirefoxExtension({ extensionPath: build.path });
  try {
    const account = await stack.createPairableAccount("firefox-restart");
    await pairThroughPopupFirefox(firefox, proxy.origin, account.pairingCode);

    const stored = async (): Promise<string[]> =>
      visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN);
    // One tab holds the fixture pages; the popup tab was closed after pairing.
    const tab = await firefox.openTab(`${site.origin}/p/99`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const expected: string[] = ["/p/99"];

    // A new event page has a new `performance.timeOrigin`: proves every termination was a restart.
    const bootIds = new Set<string>();
    const noteBoot = async (): Promise<void> => {
      bootIds.add(
        await firefox.evaluateInBackground<string>("return String(performance.timeOrigin)"),
      );
    };

    for (let round = 0; round < KILLS; round++) {
      const parkResponses = round % 2 === 0;
      proxy.setMode(parkResponses ? "hold-responses" : "hold-requests");

      // Capture. In the second half of every four rounds the event page is still terminated from
      // the previous round, so this navigation wakes it through its primed top-level listeners.
      const path = `/p/${100 + round}`;
      expected.push(path);
      await firefox.navigate(tab, `${site.origin}${path}`);
      await new Promise((resolve) => setTimeout(resolve, 400));

      // A flush starts and its request is in flight (parked by the proxy). Starting it also starts
      // the event page if nothing woke it yet (without any browser event).
      await noteBoot();
      await triggerFlushFirefox(firefox);
      await proxy.waitForHeld(1, 60_000);
      const inStore = await stored();
      if (parkResponses) {
        // The API already stored this batch; only the response is outstanding.
        expect(inStore, `round ${round}`).toContain(path);
      } else {
        // The batch never reached the API.
        expect(inStore, `round ${round}`).not.toContain(path);
      }

      // The event page is terminated with the request in flight, and the browser cancels it.
      await firefox.suspendBackground({ harsh: true });
      expect(await firefox.isBackgroundRunning(), `round ${round}`).toBe(false);
      await expect
        .poll(() => proxy.heldGone, { message: `round ${round}: the request is cancelled` })
        .toBe(proxy.heldNow);
      proxy.releaseHeld();
    }

    // Every termination happened with a request in flight, and the browser cancelled every one.
    expect(proxy.counts.held).toBeGreaterThanOrEqual(KILLS);
    expect(proxy.counts.abandoned).toBe(proxy.counts.held);

    // Back online: the queue still holds what was never confirmed and sends it again.
    proxy.setMode("online");
    await noteBoot();
    expect(bootIds.size).toBe(KILLS + 1);
    await triggerFlushFirefox(firefox);
    await expect
      .poll(async () => countByPath(await stored()), {
        timeout: RECONNECT_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toEqual(Object.fromEntries(expected.map((path) => [path, 1])));

    // Settled: a later flush finds nothing new, and the resends were absorbed by the dedupe key.
    await triggerFlushFirefox(firefox);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const events = await stack.eventsOf(account.integrationId);
    expect(countByPath(visitedPaths(events, ALLOWED_DOMAIN))).toEqual(
      Object.fromEntries(expected.map((path) => [path, 1])),
    );
    expect(new Set(events.map((event) => event.client_event_id)).size).toBe(events.length);
    // The stored-but-unconfirmed batches really were sent twice and discarded as duplicates.
    expect(await stack.duplicateCountOf(account.integrationId)).toBeGreaterThan(0);
  } finally {
    await firefox.close().catch(() => {});
    await build.cleanup();
    await proxy.close();
  }
});
