import type { Page, Worker } from "@playwright/test";
import {
  EXTENSION_PATH,
  killServiceWorker,
  launchExtension,
  serviceWorkerStatus,
  startServiceWorker,
  waitForServiceWorker,
} from "../support/extension";
import { test as base, expect } from "../support/fixtures";
import { type FlakyProxy, startFlakyProxy } from "../support/flaky-proxy";
import {
  countByPath,
  pairThroughPopup,
  seedAllowListChromium,
  triggerFlushChromium,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import type { PairedAccount } from "../support/stack";

// M2-05 / M2-R gap: a background restart in the MIDDLE of a flush, on the REAL build.
//
// The service worker is killed (CDP `ServiceWorker.stopWorker`, the harshest kill there is) while a
// flush request is in flight, 20 times, with captures in between. The proxy parks the in-flight
// request in one of two places, alternating:
//   - `hold-requests`: the batch has not reached the API (never stored by this attempt);
//   - `hold-responses`: the API stored the batch and the response is still on the way.
// After the kill the browser cancels the request, so the client never learns what happened. The
// queue must keep every event (IndexedDB) and resend it with the same id; the API's
// `UNIQUE (user_id, integration_id, client_event_id)` makes the resend a no-op. Assertions: every
// visited path is in the database exactly once, all client_event_ids are distinct, none lost.
//
// Needs Docker (Testcontainers) or E2E_DATABASE_URL, the built API and the built extension
// (`pnpm test:e2e:edge` builds them). Not part of the Edge smoke, so CI does not run it. The Firefox counterpart is
// extension-restart-flush-firefox.spec.ts.

const ALLOWED_DOMAIN = "127.0.0.1";
const KILLS = 20;
const RECONNECT_TIMEOUT_MS = 120_000;

interface Paired {
  account: PairedAccount;
  proxy: FlakyProxy;
  extension: Awaited<ReturnType<typeof launchExtension>>;
  /** A normal tab the tests navigate; the extension sees these navigations. */
  page: Page;
}

const test = base.extend<{ paired: Paired }>({
  paired: async ({ stack }, use) => {
    const proxy = await startFlakyProxy(stack.apiOrigin);
    const build = await patchBuildWithHostPermissions(EXTENSION_PATH, [LOOPBACK_HOST_PERMISSION]);
    const extension = await launchExtension({ extensionPath: build.path });
    try {
      const worker = await waitForServiceWorker(extension.context);
      const page = await extension.context.newPage();
      const account = await stack.createPairableAccount("restart");
      await pairThroughPopup(extension, proxy.origin, account.pairingCode);
      await seedAllowListChromium(worker, [ALLOWED_DOMAIN]);
      await use({ account, proxy, extension, page });
    } finally {
      await extension.close().catch(() => {});
      await build.cleanup();
      await proxy.close();
    }
  },
});

test.describe("Chromium: background restart in the middle of a flush", () => {
  test("20 service worker kills while a flush is in flight lose nothing and store nothing twice", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(480_000);
    const { page, proxy, extension, account } = paired;
    const { context, extensionId } = extension;

    const stored = async (): Promise<string[]> =>
      visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN);
    const expected: string[] = [];
    const bootIds = new Set<string>();
    const noteBoot = async (worker: Worker): Promise<void> => {
      bootIds.add(await worker.evaluate(() => `${performance.timeOrigin}`));
    };

    let worker = await waitForServiceWorker(context);

    for (let round = 0; round < KILLS; round++) {
      const parkResponses = round % 2 === 0;
      proxy.setMode(parkResponses ? "hold-responses" : "hold-requests");

      // Capture: the visit is recorded in the queue. In the second half of every four rounds the
      // worker is still dead from the previous kill, so this navigation wakes it (top-level
      // listeners), exactly as in the browser.
      const path = `/p/${100 + round}`;
      expected.push(path);
      await page.goto(`${site.origin}${path}`);
      await page.waitForTimeout(400);

      // A flush starts and its request is in flight (parked by the proxy).
      worker = await waitForServiceWorker(context);
      await noteBoot(worker);
      await triggerFlushChromium(worker);
      await proxy.waitForHeld(1);
      const inStore = await stored();
      if (parkResponses) {
        // The API already stored this batch; only the response is outstanding.
        expect(inStore, `round ${round}`).toContain(path);
      } else {
        // The batch never reached the API.
        expect(inStore, `round ${round}`).not.toContain(path);
      }

      // The browser stops the worker with the request in flight.
      await killServiceWorker(context);
      await expect
        .poll(() => proxy.heldGone, { message: `round ${round}: the request is cancelled` })
        .toBe(proxy.heldNow);
      proxy.releaseHeld();

      // Alternate how the worker comes back: explicitly, or on the next navigation's event.
      if (round % 4 < 2) worker = await startServiceWorker(context, extensionId);
    }

    // Every kill happened with a request in flight, and the browser cancelled every one of them.
    expect(proxy.counts.held).toBeGreaterThanOrEqual(KILLS);
    expect(proxy.counts.abandoned).toBe(proxy.counts.held);

    // Back online: the queue still holds what was never confirmed and sends it again.
    proxy.setMode("online");
    if ((await serviceWorkerStatus(context)) !== "running") {
      worker = await startServiceWorker(context, extensionId);
    } else {
      worker = await waitForServiceWorker(context);
    }
    await noteBoot(worker);
    // Every kill really ended a worker: the initial one and one per kill, all distinct.
    expect(bootIds.size).toBe(KILLS + 1);
    await triggerFlushChromium(worker);
    await expect
      .poll(async () => countByPath(await stored()), {
        timeout: RECONNECT_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toEqual(Object.fromEntries(expected.map((path) => [path, 1])));

    // Settled: a later flush finds nothing new, and the resends were absorbed by the dedupe key.
    await triggerFlushChromium(worker);
    await page.waitForTimeout(3_000);
    const events = await stack.eventsOf(account.integrationId);
    expect(countByPath(visitedPaths(events, ALLOWED_DOMAIN))).toEqual(
      Object.fromEntries(expected.map((path) => [path, 1])),
    );
    expect(new Set(events.map((event) => event.client_event_id)).size).toBe(events.length);
    // The stored-but-unconfirmed batches really were sent twice and discarded as duplicates.
    expect(await stack.duplicateCountOf(account.integrationId)).toBeGreaterThan(0);
  });
});
