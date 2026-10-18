import type { FirefoxTab } from "../support/firefox";
import {
  FIREFOX_EXTENSION_PATH,
  type LaunchedFirefoxExtension,
  launchFirefoxExtension,
} from "../support/firefox";
import { test as base, expect } from "../support/fixtures";
import { type FlakyProxy, startFlakyProxy } from "../support/flaky-proxy";
import {
  CONNECTION_KEY,
  countByPath,
  pageVisits,
  pairThroughPopupFirefox,
  seedAllowListFirefox,
  triggerFlushFirefox,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import type { PairedAccount } from "../support/stack";

// M4-00: the Firefox side of the M2-08 e2e (the Chromium spec keeps only a smoke now). The real
// firefox-mv3 build in headless Firefox, the real API and a real Postgres:
//
//   pair -> visit fixture pages -> events in the DB; deny by default for other domains
//   go offline -> visit more pages -> reconnect -> nothing lost, nothing duplicated
//   the API stores a batch but the response is lost -> resend -> stored once
//   the event page is terminated while events only sit in the queue -> they still arrive once
//
// Needs `pnpm --filter extension build:firefox`, the built API, Firefox + geckodriver and Docker
// (or E2E_DATABASE_URL). Always runs in CI via `test:e2e`.
//
// The extension talks to the API through a loopback proxy (support/flaky-proxy.ts); the build under
// test is a copy whose manifest already holds the loopback host permission (patched-build.ts).

const ALLOWED_DOMAIN = "127.0.0.1";
/** Failure backoff is at least 30 s (alarms cannot fire sooner), plus up to 25% jitter. */
const RECONNECT_TIMEOUT_MS = 120_000;

interface Unpaired {
  proxy: FlakyProxy;
  firefox: LaunchedFirefoxExtension;
  /** A normal tab the tests navigate; the extension sees these navigations. */
  tab: FirefoxTab;
}

interface Paired extends Unpaired {
  account: PairedAccount;
}

const test = base.extend<{ unpaired: Unpaired; paired: Paired }>({
  unpaired: async ({ stack, site }, use) => {
    const proxy = await startFlakyProxy(stack.apiOrigin);
    const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
      LOOPBACK_HOST_PERMISSION,
    ]);
    const firefox = await launchFirefoxExtension({ extensionPath: build.path });
    try {
      const tab = await firefox.openTab(`${site.origin}/`);
      await use({ proxy, firefox, tab });
    } finally {
      await firefox.close().catch(() => {});
      await build.cleanup();
      await proxy.close();
    }
  },
  paired: async ({ unpaired, stack }, use) => {
    const account = await stack.createPairableAccount("firefox-sync");
    await pairThroughPopupFirefox(unpaired.firefox, unpaired.proxy.origin, account.pairingCode);
    await seedAllowListFirefox(unpaired.firefox, [ALLOWED_DOMAIN]);
    await use({ ...unpaired, account });
  },
});

/** Navigates and gives the extension a moment to record the visit in its queue. */
async function visit(firefox: LaunchedFirefoxExtension, tab: FirefoxTab, url: string) {
  await firefox.navigate(tab, url);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

test.describe("Firefox: pair, collect, sync", () => {
  test("a wrong pairing code does not connect the extension and shows an error", async ({
    unpaired,
  }) => {
    const { firefox } = unpaired;
    const popup = await firefox.openTab(
      `moz-extension://${firefox.extensionUuid}/popup.html?tab=1`,
    );
    await firefox.typeInto(popup, "#server-url", unpaired.proxy.origin);
    await firefox.typeInto(popup, "#pairing-code", "NOT-A-REAL-CODE");
    await firefox.click(popup, "#connect");
    await expect
      .poll(() => firefox.attributeOf(popup, "#status", "data-error"), {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe("true");
    expect(await firefox.storageGet(CONNECTION_KEY)).toEqual({});
  });

  test("stores nothing for a domain that is not on the allow list", async ({
    paired,
    stack,
    site,
  }) => {
    const { firefox, tab, account } = paired;
    const port = new URL(site.origin).port;
    // Same server, different hostname: not on the allow list, so deny by default applies.
    await visit(firefox, tab, `http://localhost:${port}/p/90`);
    await visit(firefox, tab, `${site.origin}/p/91`);
    await triggerFlushFirefox(firefox);

    // The allowed visit is the barrier: once it arrived, the earlier denied one would have too.
    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN), {
        timeout: 60_000,
      })
      .toContain("/p/91");
    const events = await stack.eventsOf(account.integrationId);
    expect(pageVisits(events).filter((event) => event.data.domain === "localhost")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("localhost");
  });

  test("goes offline, keeps browsing, reconnects: every visit arrives exactly once", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { firefox, tab, proxy, account } = paired;

    await visit(firefox, tab, `${site.origin}/p/1`);
    await triggerFlushFirefox(firefox);
    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN), {
        timeout: 60_000,
      })
      .toContain("/p/1");

    // The network goes away.
    proxy.setMode("offline");
    await visit(firefox, tab, `${site.origin}/p/2`);
    await visit(firefox, tab, `${site.origin}/p/3`);
    await visit(firefox, tab, `${site.origin}/p/4`);
    await triggerFlushFirefox(firefox);
    // The extension really tried, and nothing reached the server.
    await expect.poll(() => proxy.counts.refused, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)).toEqual([
      "/p/1",
    ]);

    // Back online: the backoff alarm retries without any help.
    proxy.setMode("online");
    const all = { "/p/1": 1, "/p/2": 1, "/p/3": 1, "/p/4": 1 };
    await expect
      .poll(
        async () =>
          countByPath(visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN)),
        { timeout: RECONNECT_TIMEOUT_MS, intervals: [2_000] },
      )
      .toEqual(all);

    // Settled: a later flush finds nothing new, and nothing is stored twice.
    await triggerFlushFirefox(firefox);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const events = await stack.eventsOf(account.integrationId);
    expect(countByPath(visitedPaths(events, ALLOWED_DOMAIN))).toEqual(all);
    expect(new Set(events.map((event) => event.client_event_id)).size).toBe(events.length);
  });

  test("a batch the server stored but the client never heard back about is not stored twice", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { firefox, tab, proxy, account } = paired;

    // The API stores the batch, then the connection dies before the response arrives.
    proxy.setMode("drop-responses");
    await visit(firefox, tab, `${site.origin}/p/11`);
    await visit(firefox, tab, `${site.origin}/p/12`);
    await triggerFlushFirefox(firefox);
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

  test("events queued offline survive an event page termination and arrive once after reconnecting", async ({
    paired,
    stack,
    site,
  }) => {
    test.setTimeout(240_000);
    const { firefox, tab, proxy, account } = paired;

    proxy.setMode("offline");
    await visit(firefox, tab, `${site.origin}/p/21`);
    await visit(firefox, tab, `${site.origin}/p/22`);

    // The browser stops the event page while events are only in the queue (IndexedDB).
    await firefox.suspendBackground({ harsh: true });
    expect(await firefox.isBackgroundRunning()).toBe(false);
    // Starting a flush revives it from storage alone.
    await triggerFlushFirefox(firefox);
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
