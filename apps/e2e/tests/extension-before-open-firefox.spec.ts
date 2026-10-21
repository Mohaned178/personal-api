import { launchFirefoxExtension } from "../support/firefox";
import { expect, test } from "../support/fixtures";

// M9-05: "pause before opening", on the real firefox-mv3 build in headless Firefox.
//
//   - the user picked a site; opening it first shows the extension's pause page, whose address
//     carries the pick id and nothing else;
//   - "Continue" is off during the countdown, then goes back to the page the user was opening, and
//     moving around inside the site does not pause again;
//   - a site that is not picked opens normally;
//   - the extension keeps no page: only the picked pattern, the pause length and ids are stored.
//
// The pause does not need a server, so there is no API or database here. Needs
// `pnpm --filter extension build:firefox` and Firefox + geckodriver. Always runs in CI via
// `test:e2e`.

const PICKED_DOMAIN = "127.0.0.1";
const PICK_ID = "0192f1c2-7c1e-7a3b-9f00-0000000000a1";
const PAUSE_SECONDS = 5;
const WAIT_MS = 30_000;

test.describe("Firefox: pause before opening", () => {
  test("a picked site waits for Continue, then opens and is not paused again", async ({ site }) => {
    test.setTimeout(120_000);
    const firefox = await launchFirefoxExtension();
    try {
      const port = new URL(site.origin).port;
      const picked = (path: string) => `http://${PICKED_DOMAIN}:${port}${path}`;
      const pausePage = `moz-extension://${firefox.extensionUuid}/before-open.html?p=${PICK_ID}`;
      const tab = await firefox.openTab("about:blank");
      await firefox.storageSet({
        beforeOpen: {
          seconds: PAUSE_SECONDS,
          sites: [{ id: PICK_ID, pattern: PICKED_DOMAIN }],
        },
      });

      // Opening the picked site lands on the pause page, with Continue off while it counts down.
      const wanted = picked("/p/1?secret=query");
      await firefox.navigate(tab, wanted).catch(() => {});
      await expect
        .poll(() => firefox.tabUrl(tab).catch(() => ""), { timeout: WAIT_MS, intervals: [250] })
        .toBe(pausePage);
      await expect
        .poll(() => firefox.isDisplayed(tab, "#continue"), { timeout: 15_000 })
        .toBe(true);
      expect(await firefox.attributeOf(tab, "#continue", "disabled")).not.toBeNull();
      expect(await firefox.textOf(tab, "#summary")).toContain(PICKED_DOMAIN);

      // After the countdown, Continue opens the page that was asked for, query and all.
      await expect
        .poll(() => firefox.attributeOf(tab, "#continue", "disabled"), {
          timeout: WAIT_MS,
          intervals: [250],
        })
        .toBeNull();
      await firefox.click(tab, "#continue");
      await expect
        .poll(() => firefox.tabUrl(tab).catch(() => ""), { timeout: WAIT_MS, intervals: [250] })
        .toBe(wanted);

      // Moving around inside the site does not pause again.
      const next = picked("/p/2");
      await firefox.navigate(tab, next);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await firefox.tabUrl(tab)).toBe(next);

      // The extension keeps no page: no path, no query.
      const stored = JSON.stringify(await firefox.storageGet(null));
      expect(stored).not.toContain("/p/");
      expect(stored).not.toContain("secret");
    } finally {
      await firefox.close().catch(() => {});
    }
  });

  test("a site that is not picked opens normally", async ({ site }) => {
    const firefox = await launchFirefoxExtension();
    try {
      const tab = await firefox.openTab("about:blank");
      await firefox.storageSet({
        beforeOpen: {
          seconds: PAUSE_SECONDS,
          sites: [{ id: PICK_ID, pattern: "not-this-site.test" }],
        },
      });
      const page = `${site.origin}/p/3`;
      await firefox.navigate(tab, page);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await firefox.tabUrl(tab)).toBe(page);
    } finally {
      await firefox.close().catch(() => {});
    }
  });
});
