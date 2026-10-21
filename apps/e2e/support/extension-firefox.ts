import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================================
// M2-00c test contract: Firefox e2e smoke harness for the REAL extension.
//
// The Firefox counterpart of support/extension.ts (Chromium). apps/e2e/tests/
// extension-firefox.spec.ts is the only consumer and knows nothing about Selenium, geckodriver or
// Marionette. The mechanics were proven by Spike C (support/spike-firefox.ts, ADR 0002); this
// harness targets `apps/extension/.output/firefox-mv3` instead of the throwaway spike build and
// has no `__spike` object to talk to: it reads the extension through the standard WebExtension
// API (`browser.*`) evaluated INSIDE the background context. The implementer may extract the
// shared launch / chrome-context mechanics out of spike-firefox.ts, but must leave Spike C's
// behaviour (and tests) unchanged.
//
// WHY NOT PLAYWRIGHT: Playwright's Firefox is a patched build that cannot load WebExtensions. The
// spec runs under the Playwright TEST RUNNER (playwright.firefox.config.ts picks up every
// `*-firefox.spec.ts`) but never uses a Playwright browser.
//
// ---- Harness requirements -------------------------------------------------------------------
//
// F1. Headless, in CI (Ubuntu) and on a dev machine. Firefox + geckodriver are located the usual
//     way (selenium-manager may download geckodriver). Each launch uses its own fresh profile
//     directory unless `userDataDir` is given.
//
// F2. The build under test is the REAL `firefox-mv3` output of `pnpm --filter extension
//     build:firefox` (`FIREFOX_EXTENSION_PATH`). If it has not been built, `launchFirefoxExtension`
//     rejects with a message that names the missing manifest and the build command. It never falls
//     back to the chrome-mv3 build or to the spike.
//
// F3. The extension is installed as a TEMPORARY add-on (release Firefox refuses unsigned add-ons;
//     this is the same call web-ext makes) with the STABLE add-on id from the manifest's
//     `browser_specific_settings.gecko.id` (`addonId`) and a pinned moz-extension UUID
//     (`extensionUuid`, pref `extensions.webextensions.uuids`). After a relaunch on the SAME
//     profile the extension therefore sees the same `browser.storage.local` and IndexedDB.
//
// F4. Observation is NON-INTRUSIVE. `manifest()`, `storageGet()`, `storageSet()`, `tabCount()` and
//     `isBackgroundRunning()` run in the extension's background context (for example Marionette's
//     chrome context reaching into the background page). They must not open a tab or a window,
//     must not open a moz-extension:// page, and must not change focus. They MAY start a
//     suspended background to answer (the way Firefox starts a primed event page), without any
//     tab, window or idle event.
//
// F5. `launchFirefoxExtension` resolves only once the extension is installed AND its background has
//     run (`browser.runtime` answers), so the first `storageGet` never races the install.
//
// ---- Semantics of each helper ---------------------------------------------------------------
//
// manifest(): `browser.runtime.getManifest()` of the INSTALLED add-on, as a plain JSON object.
//
// storageGet(keys?): `browser.storage.local.get(keys)`. With no argument (or `null`) it returns
//   everything stored; with a key or list of keys only those that exist. Values are JSON-cloned.
//
// storageSet(items): `browser.storage.local.set(items)`; resolves once the write is done.
//
// tabCount(): number of tabs `browser.tabs.query({})` reports, across all windows.
//
// openTab(url): opens a NEW tab in the (single) main window, navigates it to `url`, waits for the
//   load to finish and leaves it as the active tab. It is how the fixture site is visited while
//   the extension is installed (a real tab, like a user's).
//
// tabUrl(tab): the tab's current document URL. pageText(tab): its `document.body.innerText`.
//
// clickLink(tab, text): clicks the link whose visible text is exactly `text` and resolves after
//   the resulting navigation finished.
//
// suspendBackground(): terminates the event page the way Firefox's idle timer does (see
//   spike-firefox.ts: `extension.terminateBackground()`), NOT `runtime.reload()`, and resolves once
//   `isBackgroundRunning()` is false. In-memory state is gone, storage survives. Already stopped:
//   resolves. startBackground(): starts a suspended page explicitly without any browser event
//   (`extension.wakeupBackground()`) and resolves once it is running. isBackgroundRunning(): true
//   while the event page is alive according to the browser.
//
// close({ keepProfile }): quits the browser gracefully. Deletes the profile unless `keepProfile`
//   is set or the profile was passed in by the caller.
// =============================================================================================

/** The WXT Firefox build output. `pnpm --filter extension build:firefox` creates it. */
export const FIREFOX_EXTENSION_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../extension/.output/firefox-mv3",
);

/** The stable add-on id the Firefox manifest pins (`apps/extension/wxt.config.ts`). */
export const FIREFOX_ADDON_ID = "personal-api@personal-api.local";

/** The manifest fields the smoke tests look at; the real object has more. */
export interface FirefoxManifest {
  manifest_version: number;
  name: string;
  version: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  incognito?: string;
  background?: { scripts?: string[] };
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
}

/** Opaque handle of a browser tab (the WebDriver window handle). */
export interface FirefoxTab {
  readonly handle: string;
}

export interface LaunchedFirefoxExtension {
  /** The add-on id the harness installed under (read from the build's manifest). */
  readonly addonId: string;
  /** The extension's moz-extension host UUID (stable across relaunches of the same profile). */
  readonly extensionUuid: string;
  /** Profile directory; pass it to `launchFirefoxExtension` again to simulate a browser restart. */
  readonly userDataDir: string;

  manifest(): Promise<FirefoxManifest>;
  storageGet(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  storageSet(items: Record<string, unknown>): Promise<void>;
  tabCount(): Promise<number>;

  openTab(url: string): Promise<FirefoxTab>;
  tabUrl(tab: FirefoxTab): Promise<string>;
  pageText(tab: FirefoxTab): Promise<string>;
  clickLink(tab: FirefoxTab, text: string): Promise<void>;

  suspendBackground(): Promise<void>;
  startBackground(): Promise<void>;
  isBackgroundRunning(): Promise<boolean>;

  /** Closes the browser. Deletes the profile unless `keepProfile` is set. */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

/**
 * Launches headless Firefox with the real `firefox-mv3` build installed. Pass `userDataDir` to
 * relaunch on an existing profile (browser restart).
 */
export async function launchFirefoxExtension(
  _options: { userDataDir?: string } = {},
): Promise<LaunchedFirefoxExtension> {
  throw new Error("not implemented (M2-00c)");
}
