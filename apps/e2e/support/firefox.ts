import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================================
// M2-00c test contract: reusable Firefox e2e harness for the REAL extension (apps/extension).
//
// STUB: nothing here is implemented yet. `launchFirefoxExtension` throws "not implemented"; the
// builder replaces its body (and may extract shared internals from support/spike-firefox.ts, which
// must keep working: tests/spike-mv3-firefox.spec.ts is not to be changed or weakened).
//
// Consumers: tests/extension-smoke-firefox.spec.ts and tests/extension-harness-firefox.spec.ts
// (both match playwright.firefox.config.ts). M2-08 will reuse the harness for the Firefox smoke.
//
// ---- Requirements ---------------------------------------------------------------------------
//
// F1. Same stack as the spike harness: Selenium + geckodriver (`--allow-system-access`), Firefox
//     started with `-headless -profile <dir>` (headless is what makes it run on a display-less
//     Ubuntu CI runner), the build installed as a TEMPORARY add-on (what web-ext does over the
//     remote debugging protocol; do NOT add web-ext as a dependency), Marionette chrome context for
//     privileged control. `playwright.firefox.config.ts` is only the test runner.
//
// F2. Target is the real build `FIREFOX_EXTENSION_PATH` (apps/extension/.output/firefox-mv3,
//     `pnpm --filter extension build:firefox`), or `options.extensionPath` (a directory holding a
//     built `manifest.json`).
//
// F3. FAIL FAST, BEFORE ANY BROWSER OR PROFILE EXISTS. `launchFirefoxExtension` validates the build
//     first and rejects with an Error whose message
//       - contains the absolute path `<extensionPath>/manifest.json` that is missing/unusable, and
//       - when the manifest is MISSING also contains the exact text
//         `pnpm --filter extension build:firefox`, and
//       - when the manifest has no `browser_specific_settings.gecko.id` contains exactly that text.
//     It must not start geckodriver/Firefox and must not create `options.userDataDir`.
//
// F4. Stable identity: the add-on id is the manifest's `browser_specific_settings.gecko.id`
//     (`extensionId`). The moz-extension UUID is pinned through the pref
//     `extensions.webextensions.uuids`, so `extensionUuid` is identical after a relaunch on the
//     same `userDataDir` (that is what keeps `browser.storage.local` the same database).
//
// F5. `launchFirefoxExtension` resolves only once the extension's background (event page) is
//     running and the `browser.*` API is usable inside it.
//
// F6. Observation is NON-INTRUSIVE (like the spike's H3/H4). Every background/storage method runs
//     inside the background page through Marionette's chrome context (MarionetteCommands actor of
//     the background window global). Never open a moz-extension:// page in a tab to read state:
//     that would fire tabs events and add a tab. If the event page is not running (Firefox
//     suspends an idle one after ~30 s, or `suspendBackground()` was called), a read or write
//     starts it first (`extension.wakeupBackground()`), without creating tabs/windows.
//
// F7. `storageSet`/`storageGet`/`storageClear` act on `browser.storage.local` of the extension.
//     Values cross the boundary as structured data, NEVER by string-concatenating them into a
//     script (a value with quotes, backticks, newlines or `</script>` must round-trip unchanged).
//
// F8. `close()` quits the browser gracefully and deletes the profile when the harness created it,
//     unless `keepProfile` is set. A caller-supplied `userDataDir` is never deleted.
// =============================================================================================

/** Build output of the real extension for Firefox (`pnpm --filter extension build:firefox`). */
export const FIREFOX_EXTENSION_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../extension/.output/firefox-mv3",
);

/** Opaque handle of a browser tab (the WebDriver window handle). */
export interface FirefoxTab {
  readonly handle: string;
}

export interface LaunchFirefoxOptions {
  /** Directory holding the built extension (default `FIREFOX_EXTENSION_PATH`). */
  extensionPath?: string;
  /** Profile directory. Pass the previous `userDataDir` to simulate a browser restart. */
  userDataDir?: string;
}

export interface LaunchedFirefoxExtension {
  /** Profile directory; pass it to `launchFirefoxExtension` again to simulate a restart. */
  readonly userDataDir: string;
  /** The add-on id from the manifest (`browser_specific_settings.gecko.id`). */
  readonly extensionId: string;
  /** The extension's moz-extension host UUID (stable across relaunches of the same profile). */
  readonly extensionUuid: string;

  /** Opens a NEW tab, loads `url`, waits for the load to finish, leaves it active. */
  openTab(url: string): Promise<FirefoxTab>;
  /** Loads `url` in `tab` (activating it first), resolves after the load finished. */
  navigate(tab: FirefoxTab, url: string): Promise<void>;
  /** The tab's document URL as the page sees it (query string and fragment included). */
  tabUrl(tab: FirefoxTab): Promise<string>;
  /** The tab's document title. */
  tabTitle(tab: FirefoxTab): Promise<string>;

  /** True while the extension's event page is alive according to the browser. */
  isBackgroundRunning(): Promise<boolean>;
  /**
   * Terminates the event page on demand (Firefox's own idle termination, no tabs/events fired) and
   * resolves once `isBackgroundRunning()` is false. Resolves immediately if already stopped.
   */
  suspendBackground(): Promise<void>;
  /**
   * Evaluates `functionBody` (a function BODY, so it uses `return`) inside the running background
   * page, awaits a returned promise and resolves with the structured-cloneable result. Starts the
   * page first if needed (F6). Rejects with the page's error message if the script throws.
   */
  evaluateInBackground<T>(functionBody: string): Promise<T>;

  /**
   * `browser.storage.local.get(keys)` in the background. `undefined`/`null` returns everything;
   * a string or array returns only those keys that exist (missing keys are absent, not undefined).
   */
  storageGet(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  /** `browser.storage.local.set(items)` in the background (F7). */
  storageSet(items: Record<string, unknown>): Promise<void>;
  /** `browser.storage.local.clear()` in the background. */
  storageClear(): Promise<void>;

  /** Closes the browser (F8). */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

/** Launches headless Firefox with the real extension installed. See the contract above. */
export async function launchFirefoxExtension(
  _options: LaunchFirefoxOptions = {},
): Promise<LaunchedFirefoxExtension> {
  throw new Error("launchFirefoxExtension: not implemented (M2-00c)");
}
