import { FIREFOX_EXTENSION_PATH, launchFirefoxExtension } from "../support/firefox";
import { expect, test } from "../support/fixtures";
import { startFlakyProxy } from "../support/flaky-proxy";
import {
  CONNECTION_KEY,
  countByPath,
  pairThroughPopupFirefox,
  type StoredConnection,
  seedAllowListFirefox,
  triggerFlushFirefox,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";

// M2-08, Firefox smoke (M2-00c harness): pair -> visit fixture -> events in the DB.
//
// Needs `pnpm --filter extension build:firefox`, the built API, Firefox + geckodriver and Docker
// (or E2E_DATABASE_URL). Run with `pnpm --filter @personal-api/e2e test:e2e:firefox:smoke`.
// Always runs in CI.
//
// Differences from the Chromium spec, on purpose:
// - The harness has no click on a moz-extension page through the Marionette chrome context, but
//   WebDriver element commands (trusted input) work in the popup page opened in a tab, so pairing
//   goes through the real popup form: connect(), the queue owner adoption and the stored
//   connection are the shipped code, with no test-only hooks.
// - The build under test is a copy whose manifest already holds the loopback host permission (see
//   support/patched-build.ts), because the permission prompt cannot be answered by automation.

const ALLOWED_DOMAIN = "127.0.0.1";

test("Firefox: pairs, visits fixture pages and the events land in the database", async ({
  stack,
  site,
}) => {
  const proxy = await startFlakyProxy(stack.apiOrigin);
  const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
    LOOPBACK_HOST_PERMISSION,
  ]);
  const firefox = await launchFirefoxExtension({ extensionPath: build.path });
  try {
    // Without the host permission the extension could never reach the server: fail with a clear
    // message instead of waiting for a flush that cannot happen.
    const granted = await firefox.evaluateInBackground<boolean>(
      `return browser.permissions.contains({ origins: [${JSON.stringify(LOOPBACK_HOST_PERMISSION)}] })`,
    );
    expect(granted, "the temporary add-on must hold the loopback host permission").toBe(true);

    // Pair through the real popup page, the same one the toolbar popup links to (`?tab=1`), driven
    // with WebDriver element commands (trusted input, so `permissions.request` sees a user
    // gesture). This runs the shipped connect() and its queue owner adoption, not a copy of them.
    const account = await stack.createPairableAccount("firefox");
    await pairThroughPopupFirefox(firefox, proxy.origin, account.pairingCode);

    const stored = (await firefox.storageGet(CONNECTION_KEY))[CONNECTION_KEY] as
      | StoredConnection
      | undefined;
    expect(stored?.serverOrigin).toBe(proxy.origin);
    expect(stored?.integrationId).toBe(account.integrationId);
    expect(stored?.ingestKey).toMatch(/^pa_ing_.{10,}/);
    expect(await stack.pairingCodeUsed(account.integrationId)).toBe(true);
    await seedAllowListFirefox(firefox, [ALLOWED_DOMAIN]);

    // Visit the fixture site; the query string must never be stored.
    const tab = await firefox.openTab(`${site.origin}/a`);
    await firefox.navigate(tab, `${site.origin}/b?q=secret#frag`);
    await triggerFlushFirefox(firefox);

    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), ALLOWED_DOMAIN), {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toEqual(expect.arrayContaining(["/a", "/b"]));

    const events = await stack.eventsOf(account.integrationId);
    for (const event of events) {
      expect(event.user_id).toBe(account.userId);
      expect(event.integration_id).toBe(account.integrationId);
    }
    const counts = countByPath(visitedPaths(events, ALLOWED_DOMAIN));
    expect(counts["/a"]).toBe(1);
    expect(counts["/b"]).toBe(1);
    const serialized = JSON.stringify(events.map((event) => event.data));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("frag");
    expect(serialized).not.toMatch(/[?#]/);
  } finally {
    await firefox.close().catch(() => {});
    await build.cleanup();
    await proxy.close();
  }
});
