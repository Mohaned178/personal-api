import type { Page, Worker } from "@playwright/test";
import {
  EXTENSION_PATH,
  killServiceWorker,
  launchExtension,
  startServiceWorker,
  waitForServiceWorker,
} from "../support/extension";
import { test as base, expect } from "../support/fixtures";
import { type FlakyProxy, startFlakyProxy } from "../support/flaky-proxy";
import {
  countByPath,
  pageVisits,
  pairThroughPopup,
  readConnectionChromium,
  type StoredConnection,
  seedAllowListChromium,
  triggerFlushChromium,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import type { PairedAccount } from "../support/stack";

// M2-08 (Edge smoke since M4-00: the tests tagged @smoke run in CI, the rest via test:e2e:edge;
// the Firefox suite, extension-sync-firefox.spec.ts, is the primary): the real extension build in Chromium, the real API and a real Postgres.
//
//   pair (popup form + dashboard code) -> visit fixture pages -> events in the DB
//   go offline -> visit more pages -> reconnect -> nothing lost, nothing duplicated
//
// Needs Docker (Testcontainers) or E2E_DATABASE_URL, the built API and the built extension:
// `pnpm test:e2e:edge:smoke` (or `test:e2e:edge` for all of it) builds them. The smoke runs in CI.
//
// The extension talks to the API through a loopback proxy (support/flaky-proxy.ts), which is how
// "the network goes away" is simulated: Playwright's offline switch does not reach an extension.
// The build under test is a copy whose manifest already holds the loopback host permission, so the
// browser's permission prompt (which no automation can click) is a no-op; see patched-build.ts.

const ALLOWED_DOMAIN = "127.0.0.1";
/** Failure backoff is at least 30 s (alarms cannot fire sooner), plus up to 25% jitter. */
const RECONNECT_TIMEOUT_MS = 120_000;

interface Paired {
  account: PairedAccount;
  proxy: FlakyProxy;
  extension: Awaited<ReturnType<typeof launchExtension>>;
  worker: Worker;
  /** A normal tab the tests navigate; the extension sees these navigations. */
  page: Page;
}

const test = base.extend<{ unpaired: Omit<Paired, "account">; paired: Paired }>({
  unpaired: async ({ stack }, use) => {
    const proxy = await startFlakyProxy(stack.apiOrigin);
    const build = await patchBuildWithHostPermissions(EXTENSION_PATH, [LOOPBACK_HOST_PERMISSION]);
    const extension = await launchExtension({ extensionPath: build.path });
    try {
      const worker = await waitForServiceWorker(extension.context);
      const page = await extension.context.newPage();
      await use({ proxy, extension, worker, page });
    } finally {
      await extension.close().catch(() => {});
      await build.cleanup();
      await proxy.close();
    }
  },
  paired: async ({ unpaired, stack }, use) => {
    const account = await stack.createPairableAccount("chromium");
    await pairThroughPopup(unpaired.extension, unpaired.proxy.origin, account.pairingCode);
    await seedAllowListChromium(unpaired.worker, [ALLOWED_DOMAIN]);
    await use({ ...unpaired, account });
  },
});

/** Navigates and gives the extension a moment to record the visit in its queue. */
async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForTimeout(400);
}

test.describe("Chromium: pair, collect, sync", () => {
  test("pairs through the popup with a dashboard code and stores an ingest key, once @smoke", async ({
    unpaired,
    stack,
  }) => {
    const account = await stack.createPairableAccount("pair");
    await pairThroughPopup(unpaired.extension, unpaired.proxy.origin, account.pairingCode);

    const connection = (await readConnectionChromium(unpaired.worker)) as StoredConnection;
    expect(connection.serverOrigin).toBe(unpaired.proxy.origin);
    expect(connection.integrationId).toBe(account.integrationId);
    expect(connection.ingestKey).toMatch(/^pa_ing_.{10,}/);
    expect(await stack.pairingCodeUsed(account.integrationId)).toBe(true);

    // The code is single use: a second redemption is refused.
    const again = await fetch(`${stack.apiOrigin}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: account.pairingCode }),
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe("pairing.code_invalid");
  });

  test("a wrong pairing code does not connect the extension and shows an error", async ({
    unpaired,
  }) => {
    const page = await unpaired.extension.context.newPage();
    await page.goto(`chrome-extension://${unpaired.extension.extensionId}/popup.html?tab=1`);
    await page.locator("#server-url").fill(unpaired.proxy.origin);
    await page.locator("#pairing-code").fill("NOT-A-REAL-CODE");
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveAttribute("data-error", "true");
    expect(await readConnectionChromium(unpaired.worker)).toBeUndefined();
  });

  test("stores a visit to an allowed fixture domain in the database, without query or fragment @smoke", async ({
    paired,
    stack,
    site,
  }) => {
    await visit(paired.page, `${site.origin}/a`);
    await visit(paired.page, `${site.origin}/b?q=secret#frag`);
    await triggerFlushChromium(paired.worker);

    await expect
      .poll(
        async () =>
          visitedPaths(await stack.eventsOf(paired.account.integrationId), ALLOWED_DOMAIN),
        {
          timeout: 60_000,
        },
      )
      .toEqual(expect.arrayContaining(["/a", "/b"]));

    const events = await stack.eventsOf(paired.account.integrationId);
    for (const event of events) {
      // Attributed to the paired user and integration, which the server took from the key.
      expect(event.user_id).toBe(paired.account.userId);
      expect(event.integration_id).toBe(paired.account.integrationId);
    }
    // Invariant 3: no query string, fragment or title ever reaches the database.
    const serialized = JSON.stringify(events.map((event) => event.data));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("frag");
    expect(serialized).not.toContain("Fixture");
    expect(serialized).not.toMatch(/[?#]/);
    // Each path was visited once, so it is stored once.
    const counts = countByPath(visitedPaths(events, ALLOWED_DOMAIN));
    expect(counts["/a"]).toBe(1);
    expect(counts["/b"]).toBe(1);
  });

  test("stores nothing for a domain that is not on the allow list", async ({
    paired,
    stack,
    site,
  }) => {
    const port = new URL(site.origin).port;
    // Same server, different hostname: not on the allow list, so deny by default applies.
    await visit(paired.page, `http://localhost:${port}/p/90`);
    await visit(paired.page, `${site.origin}/p/91`);
    await triggerFlushChromium(paired.worker);

    // The allowed visit is the barrier: once it arrived, the earlier denied one would have too.
    await expect
      .poll(
        async () =>
          visitedPaths(await stack.eventsOf(paired.account.integrationId), ALLOWED_DOMAIN),
        {
          timeout: 60_000,
        },
      )
      .toContain("/p/91");
    const events = await stack.eventsOf(paired.account.integrationId);
    expect(pageVisits(events).filter((event) => event.data.domain === "localhost")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("localhost");
  });

  test("goes offline, keeps browsing, reconnects: every visit arrives exactly once", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { page, proxy, worker, account } = paired;

    await visit(page, `${site.origin}/p/1`);
    await triggerFlushChromium(worker);
    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN), {
        timeout: 60_000,
      })
      .toContain("/p/1");

    // The network goes away.
    proxy.setMode("offline");
    await visit(page, `${site.origin}/p/2`);
    await visit(page, `${site.origin}/p/3`);
    await visit(page, `${site.origin}/p/4`);
    await triggerFlushChromium(worker);
    // The extension really tried, and nothing reached the server.
    await expect.poll(() => proxy.counts.refused, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)).toEqual([
      "/p/1",
    ]);

    // Back online: the backoff alarm retries without any help.
    proxy.setMode("online");
    await expect
      .poll(
        async () =>
          countByPath(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)),
        { timeout: RECONNECT_TIMEOUT_MS, intervals: [2_000] },
      )
      .toEqual({ "/p/1": 1, "/p/2": 1, "/p/3": 1, "/p/4": 1 });

    // Settled: a later flush finds nothing new, and nothing is stored twice.
    await triggerFlushChromium(worker);
    await page.waitForTimeout(3_000);
    const events = await stack.eventsOf(account.integrationId);
    expect(countByPath(visitedPaths(events, ALLOWED_DOMAIN))).toEqual({
      "/p/1": 1,
      "/p/2": 1,
      "/p/3": 1,
      "/p/4": 1,
    });
    expect(new Set(events.map((event) => event.client_event_id)).size).toBe(events.length);
  });

  test("a batch the server stored but the client never heard back about is not stored twice", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { page, proxy, worker, account } = paired;

    // The API stores the batch, then the connection dies before the response arrives.
    proxy.setMode("drop-responses");
    await visit(page, `${site.origin}/p/11`);
    await visit(page, `${site.origin}/p/12`);
    await triggerFlushChromium(worker);
    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN), {
        timeout: 60_000,
      })
      .toEqual(expect.arrayContaining(["/p/11", "/p/12"]));
    expect(proxy.counts.responsesDropped).toBeGreaterThan(0);

    // The client still thinks nothing was sent, so it resends the same events after its backoff.
    proxy.setMode("online");
    await expect
      .poll(() => stack.duplicateCountOf(account.integrationId), {
        timeout: RECONNECT_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toBeGreaterThan(0);

    const events = await stack.eventsOf(account.integrationId);
    expect(countByPath(visitedPaths(events, ALLOWED_DOMAIN))).toEqual({ "/p/11": 1, "/p/12": 1 });
    expect(new Set(events.map((event) => event.client_event_id)).size).toBe(events.length);
  });

  test("events queued offline survive a service worker kill and arrive once after reconnecting", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { page, proxy, account, extension } = paired;

    proxy.setMode("offline");
    await visit(page, `${site.origin}/p/21`);
    await visit(page, `${site.origin}/p/22`);

    // The browser stops the worker while events are only in the queue (IndexedDB).
    await killServiceWorker(extension.context);
    const revived = await startServiceWorker(extension.context, extension.extensionId);
    await triggerFlushChromium(revived);
    await expect.poll(() => proxy.counts.refused, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)).toEqual([]);

    proxy.setMode("online");
    await expect
      .poll(
        async () =>
          countByPath(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)),
        { timeout: RECONNECT_TIMEOUT_MS, intervals: [2_000] },
      )
      .toEqual({ "/p/21": 1, "/p/22": 1 });
  });
});
