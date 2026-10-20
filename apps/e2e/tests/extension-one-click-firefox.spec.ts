import {
  FIREFOX_EXTENSION_PATH,
  type FirefoxTab,
  launchFirefoxExtension,
} from "../support/firefox";
import { expect, test } from "../support/fixtures";
import { CONNECTION_KEY, type StoredConnection } from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";

// M8-01 one-click connect on Firefox (ADR 0003): the popup gets only the server URL, opens the
// dashboard's `/connect-extension` in a tab, the user signs in and confirms there, and the
// background pairs with the code from that tab's fragment and closes the tab.
//
// The API serves the built dashboard (`pnpm --filter web build`, part of `test:e2e`). The build
// under test holds the loopback host permission up front (support/patched-build.ts), because the
// permission prompt cannot be answered by automation. Always runs in CI.

test("Firefox: connects with one click through the dashboard", async ({ stack }) => {
  const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
    LOOPBACK_HOST_PERMISSION,
  ]);
  const firefox = await launchFirefoxExtension({ extensionPath: build.path });
  try {
    // An account that exists but is not signed in in this browser.
    const account = await stack.createPairableAccount("oneclick");

    const popup = await firefox.openTab(
      `moz-extension://${firefox.extensionUuid}/popup.html?tab=1`,
    );
    await firefox.typeInto(popup, "#server-url", stack.apiOrigin);
    const before = new Set((await firefox.tabs()).map((tab) => tab.handle));
    await firefox.click(popup, "#connect");

    // The extension opened the dashboard in a new tab.
    let dashboard: FirefoxTab | undefined;
    await expect
      .poll(
        async () => {
          dashboard = (await firefox.tabs()).find((tab) => !before.has(tab.handle));
          return dashboard !== undefined;
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(true);
    const tab = dashboard as FirefoxTab;

    // Signed out: login first, which comes back to the connect page.
    await expect
      .poll(async () => new URL(await firefox.tabUrl(tab)).pathname, { timeout: 15_000 })
      .toBe("/login");
    await firefox.typeInto(tab, "#email", account.email);
    await firefox.typeInto(tab, "#password", account.password);
    await firefox.click(tab, "button[type=submit]");
    await expect
      .poll(async () => new URL(await firefox.tabUrl(tab)).pathname, { timeout: 15_000 })
      .toBe("/connect-extension");
    await firefox.click(tab, "#connect-browser");

    // The background pairs and closes the dashboard tab; the popup shows the connection.
    await expect
      .poll(async () => (await firefox.tabs()).some((t) => t.handle === tab.handle), {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(false);
    await expect
      .poll(() => firefox.textOf(popup, "#status"), { timeout: 15_000, intervals: [250] })
      .toBe("Connected.");

    const stored = (await firefox.storageGet(CONNECTION_KEY))[CONNECTION_KEY] as
      | StoredConnection
      | undefined;
    expect(stored?.serverOrigin).toBe(stack.apiOrigin);
    expect(stored?.ingestKey).toMatch(/^pa_ing_.{10,}/);
    // A new integration made by the dashboard, not the one the fixture created.
    expect(stored?.integrationId).not.toBe(account.integrationId);
    const integrations = (await (await account.request("GET", "/v1/integrations")).json()) as {
      integrations: { id: string; name: string; kind: string }[];
    };
    expect(integrations.integrations).toContainEqual(
      expect.objectContaining({
        id: stored?.integrationId,
        kind: "browser-extension",
        name: "Firefox",
      }),
    );

    // Nothing in the extension's storage holds a pairing code: only the connection and its state.
    const everything = JSON.stringify(await firefox.storageGet(null));
    expect(everything).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  } finally {
    await firefox.close().catch(() => {});
    await build.cleanup();
  }
});
