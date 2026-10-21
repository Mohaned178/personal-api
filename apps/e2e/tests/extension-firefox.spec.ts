import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FIREFOX_ADDON_ID,
  FIREFOX_EXTENSION_PATH,
  type LaunchedFirefoxExtension,
  launchFirefoxExtension,
} from "../support/extension-firefox";
import { expect, test } from "../support/fixtures";

// M2-00c: smoke tests of the REAL extension (apps/extension .output/firefox-mv3) on headless
// Firefox. Mirrors tests/extension.spec.ts (Chromium) scenario by scenario, where it applies. The
// harness (Selenium + geckodriver, not Playwright: Playwright's Firefox cannot load extensions)
// is the contract documented at the top of support/extension-firefox.ts. Run with
// `pnpm --filter @personal-api/e2e test:e2e:firefox` (playwright.firefox.config.ts; the default
// `test:e2e` ignores this file).
//
// Differences from the Chromium spec that are deliberate:
//   - the background is an event page that is SUSPENDED (Firefox's idle termination), not a
//     service worker killed over CDP;
//   - state is read through the harness's non-intrusive background reads, never by opening a
//     moz-extension:// page.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Launches Firefox with the extension, runs `fn`, and always closes the browser. */
async function withExtension(
  fn: (extension: LaunchedFirefoxExtension) => Promise<void>,
): Promise<void> {
  const extension = await launchFirefoxExtension();
  try {
    await fn(extension);
  } finally {
    await extension.close();
  }
}

test.describe("Firefox smoke: the real firefox-mv3 build", () => {
  test("loads the extension and exposes the expected manifest", async () => {
    await withExtension(async (extension) => {
      // Not the chrome-mv3 build, not the spike: the Firefox build must exist on disk.
      const onDisk = JSON.parse(
        readFileSync(join(FIREFOX_EXTENSION_PATH, "manifest.json"), "utf8"),
      ) as { name: string; version: string };

      const manifest = await extension.manifest();
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.name).toBe(onDisk.name);
      expect(manifest.version).toBe(onDisk.version);
      expect(manifest.permissions).toEqual(["tabs", "idle", "storage", "alarms"]);
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.content_scripts).toBeUndefined();
      // Origins are requested at runtime only, and never in incognito (invariant 3).
      expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
      expect(manifest.incognito).toBe("not_allowed");
      // Firefox runs the background as an event page built from the scripts list.
      expect(manifest.background?.scripts).toEqual(["background.js"]);
    });
  });

  test("installs under the stable gecko id and a pinned moz-extension uuid", async () => {
    await withExtension(async (extension) => {
      expect(extension.addonId).toBe(FIREFOX_ADDON_ID);
      expect((await extension.manifest()).browser_specific_settings?.gecko?.id).toBe(
        FIREFOX_ADDON_ID,
      );
      expect(extension.extensionUuid).toMatch(UUID);
      expect(await extension.isBackgroundRunning()).toBe(true);
    });
  });

  test("reads and writes browser.storage.local from the background", async () => {
    await withExtension(async (extension) => {
      const value = { n: 1, nested: { list: ["a", "b"] } };
      await extension.storageSet({ probe: value });
      expect(await extension.storageGet("probe")).toEqual({ probe: value });
    });
  });

  test("returns only the requested keys, and nothing for keys that were never stored", async () => {
    await withExtension(async (extension) => {
      await extension.storageSet({ one: 1, two: 2, three: 3 });
      expect(await extension.storageGet(["one", "three"])).toEqual({ one: 1, three: 3 });
      expect(await extension.storageGet("missing")).toEqual({});
      expect(await extension.storageGet(null)).toEqual({ one: 1, two: 2, three: 3 });
    });
  });

  test("starts with empty storage on a fresh profile", async () => {
    // Profiles are isolated: a previous run's state never leaks into a new launch.
    await withExtension(async (extension) => {
      expect(await extension.storageGet()).toEqual({});
    });
  });

  test("reads and writes state without opening tabs or windows of its own", async () => {
    await withExtension(async (extension) => {
      const before = await extension.tabCount();
      await extension.storageSet({ probe: 1 });
      await extension.storageGet();
      await extension.manifest();
      await extension.isBackgroundRunning();
      // Observation must not pollute what the extension later watches (tabs, focus, history).
      expect(await extension.tabCount()).toBe(before);
    });
  });

  test("suspends the event page and starts it again with storage intact", async () => {
    await withExtension(async (extension) => {
      await extension.storageSet({ survivor: "still here" });
      expect(await extension.isBackgroundRunning()).toBe(true);

      await extension.suspendBackground();
      expect(await extension.isBackgroundRunning()).toBe(false);
      // Nothing wakes it by itself.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await extension.isBackgroundRunning()).toBe(false);

      await extension.startBackground();
      expect(await extension.isBackgroundRunning()).toBe(true);
      expect(await extension.storageGet("survivor")).toEqual({ survivor: "still here" });
    });
  });

  test("can suspend and explicitly restart the event page repeatedly", async () => {
    await withExtension(async (extension) => {
      for (let i = 0; i < 3; i++) {
        await extension.storageSet({ round: i });
        await extension.suspendBackground();
        expect(await extension.isBackgroundRunning()).toBe(false);
        await extension.startBackground();
        expect(await extension.storageGet("round")).toEqual({ round: i });
      }
    });
  });

  test("answers a storage read while the event page is suspended, by starting it", async () => {
    await withExtension(async (extension) => {
      await extension.storageSet({ lazy: true });
      await extension.suspendBackground();
      expect(await extension.isBackgroundRunning()).toBe(false);
      expect(await extension.storageGet("lazy")).toEqual({ lazy: true });
    });
  });

  test("reaches the local fixture site from a tab while the extension is installed", async ({
    site,
  }) => {
    await withExtension(async (extension) => {
      const before = await extension.tabCount();
      const tab = await extension.openTab(`${site.origin}/`);
      expect(await extension.tabUrl(tab)).toBe(`${site.origin}/`);
      expect(await extension.pageText(tab)).toContain("Fixture home");
      expect(await extension.tabCount()).toBe(before + 1);

      await extension.clickLink(tab, "/a");
      expect(await extension.tabUrl(tab)).toBe(`${site.origin}/a`);
      expect(await extension.pageText(tab)).toContain("Fixture page A");

      // The fixture answers unknown paths with a 404 body.
      const missing = await extension.openTab(`${site.origin}/nope`);
      expect(await extension.pageText(missing)).toContain("not found");
    });
  });

  test("keeps browser.storage.local across a browser restart on the same profile", async () => {
    const first = await launchFirefoxExtension();
    try {
      await first.storageSet({ persisted: true });
      await first.close({ keepProfile: true });

      const second = await launchFirefoxExtension({ userDataDir: first.userDataDir });
      try {
        // Same add-on id and pinned uuid: the relaunch sees the same storage.
        expect(second.addonId).toBe(first.addonId);
        expect(second.extensionUuid).toBe(first.extensionUuid);
        expect(await second.storageGet("persisted")).toEqual({ persisted: true });
      } finally {
        // Passed-in profile: the harness never deletes it, the test does below.
        await second.close();
      }
    } finally {
      await rm(first.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
