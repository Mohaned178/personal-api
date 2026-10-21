import type { Page, Worker } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LaunchedExtension } from "./extension";
import type { FirefoxTab, LaunchedFirefoxExtension } from "./firefox";
import type { StoredEvent } from "./stack";

// Shared by the Chromium and Firefox pairing specs (M2-08).

// Storage keys and the alarm the extension owns. They are pinned by the extension's own unit
// tests (apps/extension/lib/connect.ts, queue/constants.ts); a rename there must
// change them here too.
export const CONNECTION_KEY = "connection";
export const FLUSH_RETRY_ALARM = "pa-flush-retry";
/** M4-06: `browser.storage.local` key of the fetched rules, and the alarm that syncs them. */
export const RULES_KEY = "rulesConfig";
export const RULES_SYNC_ALARM = "pa-rules-sync";

export interface StoredConnection {
  serverOrigin: string;
  ingestKey: string;
  integrationId: string;
  integrationName: string;
}

/**
 * Pairs through the real popup form, opened in a tab (`popup.html?tab=1`, the same page the toolbar
 * popup links to). The click is a trusted user gesture, which `permissions.request` needs.
 */
export async function pairThroughPopup(
  extension: LaunchedExtension,
  serverOrigin: string,
  pairingCode: string,
): Promise<void> {
  const page: Page = await extension.context.newPage();
  try {
    await page.goto(`chrome-extension://${extension.extensionId}/popup.html?tab=1`);
    await page.locator("#server-url").fill(serverOrigin);
    await page.locator("#pairing-code").fill(pairingCode);
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Connected.");
    await expect(page.locator("#connected-view")).toBeVisible();
  } finally {
    await page.close();
  }
}

export async function readConnectionChromium(worker: Worker): Promise<unknown> {
  return worker.evaluate(
    (key) => chrome.storage.local.get(key).then((stored) => stored[key] as unknown),
    CONNECTION_KEY,
  );
}

/**
 * Makes the extension flush its queue now instead of at the next 30 s heartbeat: the flusher also
 * runs on its one-shot retry alarm, and an unpacked extension may use a near-term `when`. A flush
 * that is still inside a failure backoff does nothing, exactly as in production.
 */
export async function triggerFlushChromium(worker: Worker): Promise<void> {
  await worker.evaluate(
    (name) => chrome.alarms.create(name, { when: Date.now() + 500 }),
    FLUSH_RETRY_ALARM,
  );
}

/**
 * Pairs through the real popup page in a tab (`popup.html?tab=1`), driven with WebDriver element
 * commands. Marionette performs them as trusted input, so `permissions.request` sees the user
 * gesture it needs. This runs the shipped connect() and its queue owner adoption. The tab is closed
 * afterwards. Needs the loopback host permission to be granted up front (see patched-build.ts).
 */
export async function pairThroughPopupFirefox(
  firefox: LaunchedFirefoxExtension,
  serverOrigin: string,
  pairingCode: string,
): Promise<void> {
  const popup = await firefox.openTab(`moz-extension://${firefox.extensionUuid}/popup.html?tab=1`);
  await firefox.typeInto(popup, "#server-url", serverOrigin);
  await firefox.typeInto(popup, "#pairing-code", pairingCode);
  await firefox.click(popup, "#connect");
  await expect
    .poll(() => firefox.textOf(popup, "#status"), { timeout: 30_000, intervals: [250] })
    .toBe("Connected.");
  expect(await firefox.attributeOf(popup, "#status", "data-error")).toBe("false");
  expect(await firefox.isDisplayed(popup, "#connected-view")).toBe(true);
  await firefox.closeTab(popup);
}

/**
 * One-click connect (M8-01, ADR 0003) through the real popup and the real dashboard: the popup gets
 * only the server URL, the extension opens `/connect-extension`, the user signs in and presses
 * **Connect this browser**, and the background pairs and closes that tab. The account must exist
 * but need not be signed in in this browser. The permission for `serverOrigin` must already be in
 * the build (see `patchBuildWithHostPermissions`).
 */
export async function connectOneClickFirefox(
  firefox: LaunchedFirefoxExtension,
  serverOrigin: string,
  account: { email: string; password: string },
): Promise<void> {
  const popup = await firefox.openTab(`moz-extension://${firefox.extensionUuid}/popup.html?tab=1`);
  await firefox.typeInto(popup, "#server-url", serverOrigin);
  const before = new Set((await firefox.tabs()).map((tab) => tab.handle));
  await firefox.click(popup, "#connect");

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
  // A tab the extension has only just opened can report "" before its first navigation starts, and
  // expect.poll does not retry a callback that throws, so a non-URL counts as "no path yet".
  const pathOf = async () => {
    try {
      return new URL(await firefox.tabUrl(tab)).pathname;
    } catch {
      return "";
    }
  };

  await expect.poll(pathOf, { timeout: 15_000 }).toBe("/login");
  await firefox.typeInto(tab, "#email", account.email);
  await firefox.typeInto(tab, "#password", account.password);
  await firefox.click(tab, "button[type=submit]");
  await expect.poll(pathOf, { timeout: 15_000 }).toBe("/connect-extension");
  await firefox.click(tab, "#connect-browser");

  await expect
    .poll(async () => (await firefox.tabs()).some((t) => t.handle === tab.handle), {
      timeout: 30_000,
      intervals: [250],
    })
    .toBe(false);
  await expect
    .poll(() => firefox.textOf(popup, "#status"), { timeout: 15_000, intervals: [250] })
    .toBe("Connected.");
  await firefox.closeTab(popup);
}

export async function triggerFlushFirefox(firefox: LaunchedFirefoxExtension): Promise<void> {
  await firefox.evaluateInBackground(
    `return browser.alarms.create(${JSON.stringify(FLUSH_RETRY_ALARM)}, { when: Date.now() + 500 })`,
  );
}

/**
 * Makes the extension fetch its rules now instead of at the next minute: the sync runs on its own
 * alarm, so a near-term one-shot (kept periodic) does what the period would, sooner.
 */
export async function triggerRulesSyncFirefox(firefox: LaunchedFirefoxExtension): Promise<void> {
  await firefox.evaluateInBackground(
    `return browser.alarms.create(${JSON.stringify(RULES_SYNC_ALARM)}, { when: Date.now() + 500, periodInMinutes: 1 })`,
  );
}

/** The rule-set version of the rules the extension holds, or null when it holds none. */
export async function storedRuleSetVersionFirefox(
  firefox: LaunchedFirefoxExtension,
): Promise<number | null> {
  const stored = (await firefox.storageGet(RULES_KEY))[RULES_KEY] as
    | { config?: { ruleSetVersion?: unknown } }
    | undefined;
  const version = stored?.config?.ruleSetVersion;
  return typeof version === "number" ? version : null;
}

/** Navigates and gives the extension a moment to record the visit in its queue. */
export async function visitFirefox(
  firefox: LaunchedFirefoxExtension,
  tab: FirefoxTab,
  url: string,
): Promise<void> {
  await firefox.navigate(tab, url);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Waits until the extension holds the rules of this rule-set version (it syncs on its alarm). */
export async function syncRulesFirefox(
  firefox: LaunchedFirefoxExtension,
  version: number,
): Promise<void> {
  await triggerRulesSyncFirefox(firefox);
  await expect
    .poll(() => storedRuleSetVersionFirefox(firefox), { timeout: 60_000, intervals: [500] })
    .toBe(version);
}

/** `browser.page_visited` rows only (tab and focus events are not what these tests count). */
export const pageVisits = (events: StoredEvent[]): StoredEvent[] =>
  events.filter((event) => event.type === "browser.page_visited");

/** The `path` of every page visit with this domain, in stored order. */
export const visitedPaths = (events: StoredEvent[], domain: string): string[] =>
  pageVisits(events)
    .filter((event) => event.data.domain === domain)
    .map((event) => String(event.data.path));

/** Occurrences of each path (a duplicate shows up as a count above 1). */
export function countByPath(paths: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of paths) counts[path] = (counts[path] ?? 0) + 1;
  return counts;
}
