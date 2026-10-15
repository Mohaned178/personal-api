import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FIREFOX_EXTENSION_PATH,
  type LaunchedFirefoxExtension,
  launchFirefoxExtension,
} from "../support/firefox";
import { expect, test } from "../support/fixtures";

// M2-00c: Firefox e2e smoke. Loads the REAL `firefox-mv3` build (not the spike) in headless Firefox
// through Selenium + geckodriver (the contract is documented at the top of support/firefox.ts) and
// proves the harness can see the extension and read/write its stored state.
//
// Needs `pnpm --filter extension build:firefox` first. Run with
// `pnpm --filter @personal-api/e2e test:e2e:firefox` (playwright.firefox.config.ts; the default
// `test:e2e` ignores this file). Needs Firefox + geckodriver; always runs in CI.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The add-on id and name straight from the built manifest, independent of the harness. */
function builtManifest(): { id: string; name: string } {
  const manifest = JSON.parse(
    readFileSync(join(FIREFOX_EXTENSION_PATH, "manifest.json"), "utf8"),
  ) as {
    name: string;
    browser_specific_settings: { gecko: { id: string } };
  };
  return { id: manifest.browser_specific_settings.gecko.id, name: manifest.name };
}

async function tabCount(firefox: LaunchedFirefoxExtension): Promise<number> {
  return firefox.evaluateInBackground<number>(
    "return browser.tabs.query({}).then((t) => t.length)",
  );
}

test.describe("Firefox smoke: real extension build", () => {
  test("loads the built extension: stable add-on id, moz-extension UUID, running background", async () => {
    const expected = builtManifest();
    const firefox = await launchFirefoxExtension();
    try {
      expect(firefox.extensionId).toBe(expected.id);
      expect(firefox.extensionUuid).toMatch(UUID);
      expect(await firefox.isBackgroundRunning()).toBe(true);
      // `browser.*` is usable inside the background and it is the extension we built.
      expect(await firefox.evaluateInBackground<string>("return browser.runtime.id")).toBe(
        expected.id,
      );
      expect(
        await firefox.evaluateInBackground<number>(
          "return browser.runtime.getManifest().manifest_version",
        ),
      ).toBe(3);
      expect(
        await firefox.evaluateInBackground<string>("return browser.runtime.getManifest().name"),
      ).toBe(expected.name);
      // The profile directory exists while the browser runs.
      expect(existsSync(firefox.userDataDir)).toBe(true);
    } finally {
      await firefox.close();
    }
  });

  test("loads and navigates fixture pages, and the extension sees the tabs", async ({ site }) => {
    const firefox = await launchFirefoxExtension();
    try {
      const tab = await firefox.openTab(`${site.origin}/a`);
      expect(await firefox.tabUrl(tab)).toBe(`${site.origin}/a`);
      expect(await firefox.tabTitle(tab)).toBe("Fixture page A");

      await firefox.navigate(tab, `${site.origin}/b?q=secret#frag`);
      expect(await firefox.tabUrl(tab)).toBe(`${site.origin}/b?q=secret#frag`);
      expect(await firefox.tabTitle(tab)).toBe("Fixture page B");

      // The manifest has the `tabs` permission, so the background sees the page's URL.
      const urls = await firefox.evaluateInBackground<string[]>(
        "return browser.tabs.query({}).then((tabs) => tabs.map((t) => t.url))",
      );
      expect(urls.map((u) => u.split(/[?#]/)[0])).toContain(`${site.origin}/b`);
    } finally {
      await firefox.close();
    }
  });

  test("rejects a background script that throws, with the page's error message", async () => {
    const firefox = await launchFirefoxExtension();
    try {
      await expect(
        firefox.evaluateInBackground("throw new Error('boom from background')"),
      ).rejects.toThrow(/boom from background/);
      // The harness is still usable afterwards.
      expect(await firefox.evaluateInBackground<number>("return 1 + 1")).toBe(2);
    } finally {
      await firefox.close();
    }
  });

  test("reads and writes the extension's browser.storage.local through the harness", async () => {
    const firefox = await launchFirefoxExtension();
    try {
      // A fresh profile has none of our keys (missing keys are absent, not undefined).
      expect(await firefox.storageGet(["e2e-smoke:text", "e2e-smoke:obj"])).toEqual({});
      expect(await firefox.storageGet("e2e-smoke:text")).toEqual({});

      const tricky = "quote \" ' backtick ` newline \n </script> \\ line sep emoji 🦊 ünï";
      await firefox.storageSet({
        "e2e-smoke:text": tricky,
        "e2e-smoke:obj": { n: 1, nested: { list: [1, "two", null, true] } },
        "e2e-smoke:other": 7,
      });

      // Read back through the harness: one key, several keys, everything.
      expect(await firefox.storageGet("e2e-smoke:text")).toEqual({ "e2e-smoke:text": tricky });
      expect(await firefox.storageGet(["e2e-smoke:obj", "e2e-smoke:missing"])).toEqual({
        "e2e-smoke:obj": { n: 1, nested: { list: [1, "two", null, true] } },
      });
      const all = await firefox.storageGet();
      expect(all["e2e-smoke:text"]).toBe(tricky);
      expect(all["e2e-smoke:other"]).toBe(7);
      expect(await firefox.storageGet(null)).toEqual(all);

      // The write really landed in the extension's own storage, not in a harness-side copy.
      expect(
        await firefox.evaluateInBackground<unknown>(
          "return browser.storage.local.get('e2e-smoke:other').then((r) => r['e2e-smoke:other'])",
        ),
      ).toBe(7);

      // Overwrite.
      await firefox.storageSet({ "e2e-smoke:other": 8 });
      expect(await firefox.storageGet("e2e-smoke:other")).toEqual({ "e2e-smoke:other": 8 });

      // Clear.
      await firefox.storageClear();
      expect(await firefox.storageGet(null)).toEqual({});
    } finally {
      await firefox.close();
    }
  });

  test("reads and writes storage without opening tabs or windows of its own", async ({ site }) => {
    const firefox = await launchFirefoxExtension();
    try {
      await firefox.openTab(`${site.origin}/a`);
      const before = await tabCount(firefox);
      await firefox.storageSet({ "e2e-smoke:n": 1 });
      await firefox.storageGet();
      await firefox.storageClear();
      await firefox.isBackgroundRunning();
      expect(await tabCount(firefox)).toBe(before);
    } finally {
      await firefox.close();
    }
  });

  test("starts a suspended background on demand when state is read or written", async () => {
    const firefox = await launchFirefoxExtension();
    try {
      await firefox.storageSet({ "e2e-smoke:kept": "yes" });

      await firefox.suspendBackground();
      expect(await firefox.isBackgroundRunning()).toBe(false);
      // Suspending an already suspended page resolves.
      await firefox.suspendBackground();
      expect(await firefox.isBackgroundRunning()).toBe(false);

      // Storage survives the suspension and a read wakes the page itself.
      expect(await firefox.storageGet("e2e-smoke:kept")).toEqual({ "e2e-smoke:kept": "yes" });
      expect(await firefox.isBackgroundRunning()).toBe(true);

      // A write to a suspended page works too.
      await firefox.suspendBackground();
      await firefox.storageSet({ "e2e-smoke:after": 2 });
      expect(await firefox.storageGet("e2e-smoke:after")).toEqual({ "e2e-smoke:after": 2 });
    } finally {
      await firefox.close();
    }
  });

  test("keeps stored state and the moz-extension UUID across a browser relaunch on the same profile", async () => {
    const first = await launchFirefoxExtension();
    const userDataDir = first.userDataDir;
    let second: LaunchedFirefoxExtension | undefined;
    let other: LaunchedFirefoxExtension | undefined;
    try {
      await first.storageSet({ "e2e-smoke:persisted": { when: "before restart", n: 42 } });
      const uuid = first.extensionUuid;
      // keepProfile: the harness created the profile, but this test relaunches on it.
      await first.close({ keepProfile: true });
      expect(existsSync(userDataDir)).toBe(true);

      second = await launchFirefoxExtension({ userDataDir });
      expect(second.userDataDir).toBe(userDataDir);
      expect(second.extensionUuid).toBe(uuid);
      expect(await second.isBackgroundRunning()).toBe(true);
      expect(await second.storageGet("e2e-smoke:persisted")).toEqual({
        "e2e-smoke:persisted": { when: "before restart", n: 42 },
      });
      await second.close();
      // A caller-supplied profile is never deleted by the harness.
      expect(existsSync(userDataDir)).toBe(true);

      // A different profile does not see it: state is per profile.
      other = await launchFirefoxExtension();
      expect(other.userDataDir).not.toBe(userDataDir);
      expect(await other.storageGet("e2e-smoke:persisted")).toEqual({});
    } finally {
      await first.close({ keepProfile: true }).catch(() => {});
      await second?.close().catch(() => {});
      await other?.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test("deletes a profile it created on close, unless keepProfile is set", async () => {
    const firefox = await launchFirefoxExtension();
    const dir = firefox.userDataDir;
    expect(existsSync(dir)).toBe(true);
    await firefox.close();
    expect(existsSync(dir)).toBe(false);
  });
});
