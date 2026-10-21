import type { FirefoxTab } from "../support/firefox";
import {
  FIREFOX_EXTENSION_PATH,
  type LaunchedFirefoxExtension,
  launchFirefoxExtension,
} from "../support/firefox";
import { test as base, expect } from "../support/fixtures";
import { type FlakyProxy, startFlakyProxy } from "../support/flaky-proxy";
import {
  pairThroughPopupFirefox,
  RULES_KEY,
  triggerRulesSyncFirefox,
  visitFirefox,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import type { PairedAccount } from "../support/stack";

// M9-02: a daily site limit, on the real firefox-mv3 build in headless Firefox, the real API and a
// real Postgres.
//
//   - the user sets a short limit (1 minute) through the same HTTP route the dashboard uses;
//   - the extension gets it with its rules and, while the site is under the limit, leaves it alone;
//   - once the time on the site reaches the limit, the tab moves to the extension's "Time's up"
//     page, which names the limit and offers "5 more minutes" (not in strict mode);
//   - "5 more minutes" goes back to the page the tab came from.
//
// The time on the site is what the extension counts on the device (`todayTotals`, M8-04). A real
// minute of focused browsing would make the test slow and depend on the idle state of a headless
// browser, so the test writes the total the way the counter would, and the extension's own
// evaluation (a 30-second alarm, and every navigation) takes it from there. The counting itself
// (including the segment still open, a dropped site and a private window) is covered by the
// extension's unit tests.
//
// Needs `pnpm --filter extension build:firefox`, the built API, Firefox + geckodriver and Docker
// (or E2E_DATABASE_URL). Always runs in CI via `test:e2e`.

const SITE_DOMAIN = "127.0.0.1";
const LIMITS_ALARM = "pa-limits";
const TODAY_KEY = "todayTotals";
const LIMIT_MINUTES = 1;
const SYNC_TIMEOUT_MS = 60_000;
const BLOCK_TIMEOUT_MS = 60_000;

interface Paired {
  firefox: LaunchedFirefoxExtension;
  /** A normal tab the tests navigate; the extension sees these navigations. */
  tab: FirefoxTab;
  account: PairedAccount;
  /** URL of a fixture page. */
  url(path: string): string;
}

const test = base.extend<{ paired: Paired }>({
  paired: async ({ stack, site }, use) => {
    const proxy: FlakyProxy = await startFlakyProxy(stack.apiOrigin);
    const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
      LOOPBACK_HOST_PERMISSION,
    ]);
    const firefox = await launchFirefoxExtension({ extensionPath: build.path });
    try {
      const tab = await firefox.openTab(`${site.origin}/`);
      // The default account allows the fixture site, so its time is counted.
      const account = await stack.createPairableAccount("firefox-limits");
      await pairThroughPopupFirefox(firefox, proxy.origin, account.pairingCode);
      const port = new URL(site.origin).port;
      await use({
        firefox,
        tab,
        account,
        url: (path) => `http://${SITE_DOMAIN}:${port}${path}`,
      });
    } finally {
      await firefox.close().catch(() => {});
      await build.cleanup();
      await proxy.close();
    }
  },
});

/** The limit through the dashboard's own route; returns its id. */
async function addLimit(account: PairedAccount, strict: boolean): Promise<string> {
  const res = await account.request("POST", "/v1/limits", {
    pattern: SITE_DOMAIN,
    minutes: LIMIT_MINUTES,
    strict,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Fetches the rules (and with them the limits) now, and waits until the extension holds the limit. */
async function syncLimit(firefox: LaunchedFirefoxExtension, limitId: string): Promise<void> {
  await triggerRulesSyncFirefox(firefox);
  await expect
    .poll(
      async () => {
        const stored = (await firefox.storageGet(RULES_KEY))[RULES_KEY] as
          | { config?: { limits?: { id: string }[] } }
          | undefined;
        return stored?.config?.limits?.map((limit) => limit.id) ?? [];
      },
      { timeout: SYNC_TIMEOUT_MS, intervals: [500] },
    )
    .toEqual([limitId]);
}

/** Local `YYYY-MM-DD`, the way the extension keys its per-day state (same machine, same time zone). */
function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Writes today's time on the site, as the Today counter would have after that much browsing. */
async function setTimeOnSite(firefox: LaunchedFirefoxExtension, ms: number): Promise<void> {
  await firefox.storageSet({ [TODAY_KEY]: { date: localDate(), ms: { [SITE_DOMAIN]: ms } } });
}

/** Makes the extension evaluate its limits now instead of at the next 30-second alarm. */
async function evaluateLimits(firefox: LaunchedFirefoxExtension): Promise<void> {
  await firefox.evaluateInBackground(
    `return browser.alarms.create(${JSON.stringify(LIMITS_ALARM)}, { when: Date.now() + 500, periodInMinutes: 0.5 })`,
  );
}

/** The tab's URL, or "" while it is in the middle of a navigation. */
const urlOf = (firefox: LaunchedFirefoxExtension, tab: FirefoxTab) =>
  firefox.tabUrl(tab).catch(() => "");

test.describe("Firefox: a daily limit", () => {
  test("a used-up limit moves the tab to Time's up, and 5 more minutes goes back", async ({
    paired,
  }) => {
    test.setTimeout(180_000);
    const { firefox, tab, account, url } = paired;
    const limitId = await addLimit(account, false);
    await syncLimit(firefox, limitId);

    // Well under the limit (10 s of 1 min): the site opens and stays open.
    await setTimeOnSite(firefox, 10_000);
    const page = url("/p/limit");
    await visitFirefox(firefox, tab, page);
    await evaluateLimits(firefox);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await urlOf(firefox, tab)).toBe(page);

    // The time on the site reaches the limit: the tab is moved to the extension's page.
    await setTimeOnSite(firefox, LIMIT_MINUTES * 60_000 + 1_000);
    await evaluateLimits(firefox);
    await expect
      .poll(() => urlOf(firefox, tab), { timeout: BLOCK_TIMEOUT_MS, intervals: [500] })
      .toBe(`moz-extension://${firefox.extensionUuid}/time-up.html?l=${limitId}`);
    // The page fills itself in from storage after it loads, so wait for its content.
    await expect
      .poll(() => firefox.textOf(tab, "#summary"), { timeout: 15_000 })
      .toContain(SITE_DOMAIN);
    expect(await firefox.textOf(tab, "#title")).toBe("Time's up");
    await expect.poll(() => firefox.isDisplayed(tab, "#snooze"), { timeout: 15_000 }).toBe(true);

    // The extension keeps no page: only ids, numbers and the date are written for the limit.
    const stored = JSON.stringify(await firefox.storageGet(null));
    expect(stored).not.toContain("/p/limit");

    // "5 more minutes" goes back to the page the tab came from, and it stays open.
    await firefox.click(tab, "#snooze");
    await expect
      .poll(() => urlOf(firefox, tab), { timeout: BLOCK_TIMEOUT_MS, intervals: [500] })
      .toBe(page);
    await evaluateLimits(firefox);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await urlOf(firefox, tab)).toBe(page);
  });

  test("strict mode has no 5 more minutes", async ({ paired }) => {
    const { firefox, tab, account, url } = paired;
    const limitId = await addLimit(account, true);
    await syncLimit(firefox, limitId);

    // Visit first (nothing is used yet), then use the time up, like the other test.
    await setTimeOnSite(firefox, 10_000);
    await visitFirefox(firefox, tab, url("/p/strict"));
    await setTimeOnSite(firefox, LIMIT_MINUTES * 60_000 + 1_000);
    await evaluateLimits(firefox);
    await expect
      .poll(() => urlOf(firefox, tab), { timeout: BLOCK_TIMEOUT_MS, intervals: [500] })
      .toBe(`moz-extension://${firefox.extensionUuid}/time-up.html?l=${limitId}`);
    // The button starts hidden, so first wait for the strict note: it appears once the page has
    // read the limit, and only then does "no 5 more minutes" mean something.
    await expect.poll(() => firefox.isDisplayed(tab, "#note"), { timeout: 15_000 }).toBe(true);
    expect(await firefox.textOf(tab, "#note")).toContain("Strict mode");
    expect(await firefox.isDisplayed(tab, "#snooze")).toBe(false);
  });
});
