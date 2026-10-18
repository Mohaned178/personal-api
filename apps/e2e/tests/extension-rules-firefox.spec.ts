import type { FirefoxTab } from "../support/firefox";
import {
  FIREFOX_EXTENSION_PATH,
  type LaunchedFirefoxExtension,
  launchFirefoxExtension,
} from "../support/firefox";
import { test as base, expect } from "../support/fixtures";
import { type FlakyProxy, startFlakyProxy } from "../support/flaky-proxy";
import {
  pageVisits,
  pairThroughPopupFirefox,
  storedRuleSetVersionFirefox,
  triggerFlushFirefox,
  triggerRulesSyncFirefox,
  visitedPaths,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import { allowDomainsRule, type PairedAccount, type RuleDocument } from "../support/stack";

// M4-09: demo steps 3 and 7, on the real firefox-mv3 build in headless Firefox, the real API and a
// real Postgres.
//
//   step 3: a fresh extension collects nothing until a rule allows the site. The user adds the
//           rule, the extension syncs it, and the next visit is collected.
//   step 7: the user changes that rule. The extension syncs the new version and later visits
//           behave differently: one site stops being collected, another starts, and a transform
//           applies before the event leaves the browser.
//
// Needs `pnpm --filter extension build:firefox`, the built API, Firefox + geckodriver and Docker
// (or E2E_DATABASE_URL). Always runs in CI via `test:e2e`. The rules are saved through the same
// HTTP routes the dashboard uses (the Rules page itself is covered by apps/web's tests).
//
// Two hostnames reach the same fixture site: `127.0.0.1` and `localhost`. Which of them a rule
// allows is what the tests flip. An arrival from the allowed one is also the barrier that proves a
// denied visit made before it never reached the server: events leave in order, in one flush.

const IP_DOMAIN = "127.0.0.1";
const NAME_DOMAIN = "localhost";
const SYNC_TIMEOUT_MS = 60_000;
const ARRIVAL_TIMEOUT_MS = 60_000;

interface Paired {
  firefox: LaunchedFirefoxExtension;
  /** A normal tab the tests navigate; the extension sees these navigations. */
  tab: FirefoxTab;
  account: PairedAccount;
  /** URL of a fixture page on one of the two hostnames. */
  url(domain: string, path: string): string;
}

const test = base.extend<{ paired: Paired }>({
  // Every test starts from a user with no rule at all: the rules are part of the story.
  paired: async ({ stack, site }, use) => {
    const proxy: FlakyProxy = await startFlakyProxy(stack.apiOrigin);
    const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
      LOOPBACK_HOST_PERMISSION,
    ]);
    const firefox = await launchFirefoxExtension({ extensionPath: build.path });
    try {
      const tab = await firefox.openTab(`${site.origin}/`);
      const account = await stack.createPairableAccount("firefox-rules", []);
      await pairThroughPopupFirefox(firefox, proxy.origin, account.pairingCode);
      const port = new URL(site.origin).port;
      await use({
        firefox,
        tab,
        account,
        url: (domain, path) => `http://${domain}:${port}${path}`,
      });
    } finally {
      await firefox.close().catch(() => {});
      await build.cleanup();
      await proxy.close();
    }
  },
});

/** Navigates and gives the extension a moment to record the visit in its queue. */
async function visit(firefox: LaunchedFirefoxExtension, tab: FirefoxTab, url: string) {
  await firefox.navigate(tab, url);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Waits until the extension holds the rules of this rule-set version (it syncs on its alarm). */
async function syncRules(firefox: LaunchedFirefoxExtension, version: number) {
  await triggerRulesSyncFirefox(firefox);
  await expect
    .poll(() => storedRuleSetVersionFirefox(firefox), {
      timeout: SYNC_TIMEOUT_MS,
      intervals: [500],
    })
    .toBe(version);
}

/** The one rule the tests change: allow these domains, then any transforms. */
const allowRule = (domains: string[], transforms: RuleDocument[] = []): RuleDocument => ({
  ...allowDomainsRule(domains),
  name: "e2e: the rule under change",
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rule format's own key.
  then: [{ action: "allow" }, ...transforms],
});

test.describe("Firefox: rules decide what is collected", () => {
  test("step 3: nothing is collected until a rule allows the site, then it is", async ({
    paired,
    stack,
  }) => {
    const { firefox, tab, account, url } = paired;

    // Paired with no rule: the extension holds an empty rule set at version 0 and denies by default.
    await expect
      .poll(() => storedRuleSetVersionFirefox(firefox), { timeout: SYNC_TIMEOUT_MS })
      .toBe(0);
    await visit(firefox, tab, url(IP_DOMAIN, "/p/1"));
    await triggerFlushFirefox(firefox);

    // The user adds a rule that allows the site; the extension picks it up.
    const rule = await account.rules.create(allowRule([IP_DOMAIN]));
    expect(rule.version).toBe(1);
    await syncRules(firefox, 1);

    await visit(firefox, tab, url(IP_DOMAIN, "/p/2"));
    await triggerFlushFirefox(firefox);
    await expect
      .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), IP_DOMAIN), {
        timeout: ARRIVAL_TIMEOUT_MS,
      })
      .toContain("/p/2");

    // The visit before the rule is gone for good: it was never queued, so it cannot arrive late.
    const events = await stack.eventsOf(account.integrationId);
    expect(visitedPaths(events, IP_DOMAIN)).toEqual(["/p/2"]);
    // "Why is this here": the stored trace names the rule and its version.
    const stored = pageVisits(events)[0];
    expect(stored?.trace?.ruleSetVersion).toBe(1);
    expect(stored?.trace?.matched.map((match) => match.ruleId)).toEqual([rule.id]);
  });

  test("step 7: changing the rule changes what later visits do", async ({ paired, stack }) => {
    test.setTimeout(240_000);
    const { firefox, tab, account, url } = paired;
    const paths = async (domain: string) =>
      visitedPaths(await stack.eventsOf(account.integrationId), domain);
    const flushUntilArrived = async (domain: string, path: string) => {
      await triggerFlushFirefox(firefox);
      await expect.poll(() => paths(domain), { timeout: ARRIVAL_TIMEOUT_MS }).toContain(path);
    };

    // Version 1 allows the IP hostname only.
    const rule = await account.rules.create(allowRule([IP_DOMAIN]));
    await syncRules(firefox, 1);
    await visit(firefox, tab, url(NAME_DOMAIN, "/p/2"));
    await visit(firefox, tab, url(IP_DOMAIN, "/p/1"));
    await flushUntilArrived(IP_DOMAIN, "/p/1");
    expect(await paths(NAME_DOMAIN)).toEqual([]);

    // Version 2 allows the other hostname instead: the two flip.
    expect((await account.rules.replace(rule.id, allowRule([NAME_DOMAIN]))).version).toBe(2);
    await syncRules(firefox, 2);
    await visit(firefox, tab, url(IP_DOMAIN, "/p/3"));
    await visit(firefox, tab, url(NAME_DOMAIN, "/p/4"));
    await flushUntilArrived(NAME_DOMAIN, "/p/4");
    expect(await paths(IP_DOMAIN)).toEqual(["/p/1"]);
    expect(await paths(NAME_DOMAIN)).toEqual(["/p/4"]);

    // Version 3 keeps only the first path segment: the extension rewrites the event before it leaves.
    const coarsened = allowRule([NAME_DOMAIN], [{ action: "coarsen", segments: 1 }]);
    expect((await account.rules.replace(rule.id, coarsened)).version).toBe(3);
    await syncRules(firefox, 3);
    await visit(firefox, tab, url(NAME_DOMAIN, "/p/5"));
    await flushUntilArrived(NAME_DOMAIN, "/p");
    expect(await paths(NAME_DOMAIN)).toEqual(["/p/4", "/p"]);

    // Each stored event carries the rule-set version that decided it.
    const events = await stack.eventsOf(account.integrationId);
    expect(pageVisits(events).map((event) => event.trace?.ruleSetVersion)).toEqual([1, 2, 3]);
  });
});
