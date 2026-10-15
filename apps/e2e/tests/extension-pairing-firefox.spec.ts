import { FIREFOX_EXTENSION_PATH, launchFirefoxExtension } from "../support/firefox";
import { expect, test } from "../support/fixtures";
import { startFlakyProxy } from "../support/flaky-proxy";
import {
  CONNECTION_KEY,
  countByPath,
  seedAllowListFirefox,
  setQueueOwnerFirefox,
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
// - The harness drives the browser through Marionette and cannot click inside a moz-extension page,
//   so the pairing code is redeemed over HTTP (the same POST /v1/pair the popup sends) and the
//   result is written to the extension's storage in the shape `connect()` stores. The popup form
//   itself is covered by the Chromium spec and by the extension's unit tests.
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

    // Pair: a dashboard code, redeemed once, becomes the stored connection.
    const account = await stack.createPairableAccount("firefox");
    const paired = await fetch(`${proxy.origin}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: account.pairingCode }),
    });
    expect(paired.status).toBe(200);
    const body = (await paired.json()) as {
      ingestKey: { key: string };
      integration: { id: string; name: string };
    };
    expect(body.ingestKey.key).toMatch(/^pa_ing_/);
    expect(body.integration.id).toBe(account.integrationId);
    expect(await stack.pairingCodeUsed(account.integrationId)).toBe(true);
    // The queue is owner-scoped and only `connect()` sets the owner; do the same before anything is
    // captured, or the queued rows would be unowned and never sent.
    await setQueueOwnerFirefox(firefox, {
      serverOrigin: proxy.origin,
      integrationId: body.integration.id,
    });
    await firefox.storageSet({
      [CONNECTION_KEY]: {
        serverOrigin: proxy.origin,
        ingestKey: body.ingestKey.key,
        integrationId: body.integration.id,
        integrationName: body.integration.name,
      },
    });
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
