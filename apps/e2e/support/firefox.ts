import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { By, until } from "selenium-webdriver";
import { Context, Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";

// =============================================================================================
// M2-00c test contract: reusable Firefox e2e harness for the REAL extension (apps/extension).
//
// Implemented with Selenium + geckodriver, the same machinery as support/spike-firefox.ts (which
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
  /** Closes `tab` and returns to the first tab that is left. */
  closeTab(tab: FirefoxTab): Promise<void>;
  /** Every open tab, including the ones the extension opened or closed by itself (M8-01). */
  tabs(): Promise<FirefoxTab[]>;

  /**
   * Page interaction through WebDriver element commands, which Marionette performs as real
   * (trusted) input: they work in a moz-extension:// page, so the popup can be driven like a user
   * does, user gesture included. Each waits (up to 15 s) for the element to exist.
   * `typeInto` replaces the field's value; `click` clicks; `textOf` reads the rendered text.
   */
  typeInto(tab: FirefoxTab, selector: string, text: string): Promise<void>;
  click(tab: FirefoxTab, selector: string): Promise<void>;
  textOf(tab: FirefoxTab, selector: string): Promise<string>;
  /** `getAttribute` of the element (`null` when the attribute is absent). */
  attributeOf(tab: FirefoxTab, selector: string, name: string): Promise<string | null>;
  /** Whether the element exists and is displayed (a `hidden` element is not). */
  isDisplayed(tab: FirefoxTab, selector: string): Promise<boolean>;

  /** True while the extension's event page is alive according to the browser. */
  isBackgroundRunning(): Promise<boolean>;
  /**
   * Terminates the event page on demand (Firefox's own idle termination, no tabs/events fired) and
   * resolves once `isBackgroundRunning()` is false. Resolves immediately if already stopped.
   *
   * By default it honours Firefox's listener keep-alive: while a promise returned by one of the
   * page's listeners is pending (a flush in flight), Firefox declines to terminate, and the harness
   * waits for that promise to settle before asking again. `harsh: true` ignores the keep-alive and
   * terminates at once even with such a promise pending, like a crash, an update or a browser quit
   * would (the in-flight request is cancelled). Use it to test "the background dies mid-flush".
   */
  suspendBackground(options?: { harsh?: boolean }): Promise<void>;
  /**
   * Evaluates `functionBody` (a function BODY, so it uses `return`) inside the running background
   * page, awaits a returned promise and resolves with the structured-cloneable result. Starts the
   * page first if needed (F6). Rejects with the page's error message if the script throws.
   */
  evaluateInBackground<T>(functionBody: string, args?: unknown[]): Promise<T>;

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

/**
 * moz-extension UUID pinned for the extension's add-on id through the pref
 * `extensions.webextensions.uuids`. A fixed random value, no meaning: it only has to be the same on
 * every launch, which is what keeps `browser.storage.local` in the same database across a relaunch
 * of the same profile (F4).
 */
const PINNED_EXTENSION_UUID = "9e6c7d1a-3b8f-4c2d-8e5a-7f0b1c2d3e4f";

const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 25;

interface FirefoxManifest {
  browser_specific_settings?: { gecko?: { id?: unknown } };
}

/**
 * The add-on id the build pins (`browser_specific_settings.gecko.id`). F3: this is the first thing
 * the launcher does, so a missing or unusable build never starts geckodriver or leaves a profile
 * directory behind.
 */
function readExtensionId(extensionPath: string): string {
  const manifestPath = join(extensionPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Firefox extension build is missing: ${manifestPath} does not exist. ` +
        "Build it with `pnpm --filter extension build:firefox`.",
    );
  }
  let manifest: FirefoxManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FirefoxManifest;
  } catch (error) {
    throw new Error(
      `${manifestPath} is not a usable extension manifest: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `${manifestPath} has no browser_specific_settings.gecko.id: a temporary add-on would get a ` +
        "random id and its storage would not survive a relaunch.",
    );
  }
  return id;
}

/** Operations run in Marionette's chrome context (privileged, in Firefox's parent process). */
type ChromeOp = "state" | "uuid" | "suspend" | "wait" | "read";

/** Argument of the "read" op: the page function body and its structured-cloneable arguments. */
interface ChromeRead {
  script: string;
  args: unknown[];
}

// One privileged script for every operation. Arguments: add-on id, operation, operation argument,
// Marionette's resolve callback. Resolves with `{ value }` or `{ error }` (a message only).
const CHROME_SCRIPT = `
const [addonId, op, arg, timeoutMs, done] = arguments;
(async () => {
  const { ExtensionParent } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionParent.sys.mjs",
  );
  const extension = ExtensionParent.GlobalManager.getExtension(addonId);
  if (!extension) throw new Error("the extension add-on is not installed");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + timeoutMs;
  const state = () => extension.backgroundState;
  // Runs a function body INSIDE the event page (no moz-extension:// page, no tab, no window).
  // Arguments cross as structured data through the second parameter, never by concatenating them
  // into the script text (F7).
  const evaluate = (script, args) =>
    extension.backgroundContext.browsingContext.currentWindowGlobal
      .getActor("MarionetteCommands")
      .executeScript(script, args, { sandboxName: null, newSandbox: false, file: "e2e-firefox", line: 0 });
  // F5: the extension build has no global of its own to probe (the spike checked __spike), so
  // readiness is the background running with the browser.* API usable inside it.
  const ready = async () =>
    state() === "running" &&
    !!extension.backgroundContext &&
    (await evaluate("return typeof browser === 'object'", []).catch(() => false));
  switch (op) {
    case "state":
      return state();
    case "uuid":
      return WebExtensionPolicy.getByID(addonId).mozExtensionHostname;
    case "suspend":
      // Firefox's own event page idle timer path, called on demand. It declines while a promise
      // returned by one of the page's listeners is pending (and while DevTools is attached),
      // restarting the idle timer instead; wait those promises out and ask again, which is what the
      // timer would do a full idle period later.
      while (state() !== "stopped") {
        if (Date.now() > deadline) throw new Error("background did not stop, state " + state());
        if (state() !== "running") {
          await sleep(${POLL_MS});
          continue;
        }
        const pending = [...(extension.backgroundContext?.runListenerPromises ?? [])];
        await extension.terminateBackground();
        // "harsh" asks again at once, which terminates even with a listener promise pending.
        if (arg !== "harsh" && pending.length > 0 && state() === "running") {
          await Promise.race([
            Promise.allSettled(pending),
            sleep(Math.max(0, deadline - Date.now())),
          ]);
        }
      }
      return state();
    case "wait":
    case "read":
      // F6: a read starts a suspended page without tabs/windows/API events, and resolves only once
      // it runs and browser.* is usable.
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error("background did not start, state " + state());
        if (state() === "stopped") await extension.wakeupBackground();
        else await sleep(${POLL_MS});
      }
      return op === "read" ? await evaluate(arg.script, arg.args) : state();
    default:
      throw new Error("unknown op " + op);
  }
})().then(
  (value) => done({ value }),
  (error) => done({ error: String((error && error.message) || error) }),
);
`;

/** Launches headless Firefox with the real extension installed. See the contract above. */
export async function launchFirefoxExtension(
  options: LaunchFirefoxOptions = {},
): Promise<LaunchedFirefoxExtension> {
  const extensionPath = options.extensionPath ?? FIREFOX_EXTENSION_PATH;
  // F3: validate the build before any browser process or profile directory exists.
  const extensionId = readExtensionId(extensionPath);

  const owned = options.userDataDir === undefined;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "pa-ff-e2e-")));
  if (!owned) await mkdir(userDataDir, { recursive: true });

  const firefoxOptions = new Options()
    .addArguments("-headless", "-profile", userDataDir)
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [extensionId]: PINNED_EXTENSION_UUID }),
    );
  // Firefox 138+ only opens Marionette's chrome context when geckodriver allows system access.
  const service = new ServiceBuilder().addArguments("--allow-system-access").build();

  let driver: Driver;
  try {
    driver = Driver.createSession(firefoxOptions, service);
    await driver.getSession();
  } catch (error) {
    if (owned) await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  let context: Context | undefined;
  const useContext = async (next: Context): Promise<void> => {
    if (context === next) return;
    await driver.setContext(next);
    context = next;
  };

  const chrome = async <T>(
    op: ChromeOp,
    arg: ChromeRead | "harsh" | null = null,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<T> => {
    await useContext(Context.CHROME);
    const result = (await driver.executeAsyncScript(
      CHROME_SCRIPT,
      extensionId,
      op,
      arg,
      timeoutMs,
    )) as { value: T } | { error: string };
    if ("error" in result) throw new Error(result.error);
    return result.value;
  };

  /** Evaluates `script` (a function body) inside the event page, starting it if needed (F6). */
  const inBackground = <T>(script: string, args: unknown[] = []): Promise<T> =>
    chrome<T>("read", { script, args });

  let current = "";

  const switchTo = async (tab: FirefoxTab): Promise<void> => {
    await useContext(Context.CONTENT);
    await driver.switchTo().window(tab.handle);
    current = tab.handle;
  };

  const navigate = async (tab: FirefoxTab, url: string): Promise<void> => {
    if (current !== tab.handle) await switchTo(tab);
    await useContext(Context.CONTENT);
    await driver.get(url);
  };

  const element = async (tab: FirefoxTab, selector: string) => {
    if (current !== tab.handle) await switchTo(tab);
    await useContext(Context.CONTENT);
    return driver.wait(until.elementLocated(By.css(selector)), DEFAULT_WAIT_MS);
  };

  // The browser is up: install the temporary add-on and wait for its event page (F5).
  let extensionUuid: string;
  try {
    // Every chrome-context call bounds itself (DEFAULT_WAIT_MS or the caller's timeout).
    await driver.manage().setTimeouts({ script: 120_000 });
    await driver.installAddon(extensionPath, true);
    await chrome("wait");
    extensionUuid = await chrome<string>("uuid");
    await useContext(Context.CONTENT);
    current = await driver.getWindowHandle();
  } catch (error) {
    await driver.quit().catch(() => {});
    if (owned) {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    throw error;
  }

  return {
    userDataDir,
    extensionId,
    extensionUuid,

    openTab: async (url) => {
      await useContext(Context.CONTENT);
      await driver.switchTo().newWindow("tab");
      const tab = { handle: await driver.getWindowHandle() };
      current = tab.handle;
      await navigate(tab, url);
      return tab;
    },
    navigate,
    tabUrl: async (tab) => {
      if (current !== tab.handle) await switchTo(tab);
      await useContext(Context.CONTENT);
      return driver.executeScript<string>("return document.URL");
    },
    tabTitle: async (tab) => {
      if (current !== tab.handle) await switchTo(tab);
      await useContext(Context.CONTENT);
      return driver.executeScript<string>("return document.title");
    },

    closeTab: async (tab) => {
      if (current !== tab.handle) await switchTo(tab);
      await useContext(Context.CONTENT);
      await driver.close();
      const [first] = await driver.getAllWindowHandles();
      if (first === undefined) throw new Error("closeTab: no tab is left");
      await driver.switchTo().window(first);
      current = first;
    },
    tabs: async () => {
      await useContext(Context.CONTENT);
      return (await driver.getAllWindowHandles()).map((handle) => ({ handle }));
    },
    typeInto: async (tab, selector, text) => {
      const field = await element(tab, selector);
      await field.clear();
      await field.sendKeys(text);
    },
    click: async (tab, selector) => {
      await (await element(tab, selector)).click();
    },
    textOf: async (tab, selector) => (await element(tab, selector)).getText(),
    attributeOf: async (tab, selector, name) => (await element(tab, selector)).getAttribute(name),
    isDisplayed: async (tab, selector) => {
      const found = await element(tab, selector).catch(() => null);
      return found === null ? false : found.isDisplayed();
    },

    isBackgroundRunning: async () => (await chrome<string>("state")) === "running",
    suspendBackground: async ({ harsh = false } = {}) => {
      await chrome("suspend", harsh ? "harsh" : null);
    },
    evaluateInBackground: (functionBody, args = []) => inBackground(functionBody, args),

    storageGet: (keys) =>
      keys == null
        ? inBackground<Record<string, unknown>>("return browser.storage.local.get()")
        : inBackground<Record<string, unknown>>("return browser.storage.local.get(arguments[0])", [
            keys,
          ]),
    storageSet: (items) =>
      inBackground<void>("return browser.storage.local.set(arguments[0])", [items]),
    storageClear: () => inBackground<void>("return browser.storage.local.clear()"),

    close: async ({ keepProfile = false } = {}) => {
      try {
        await driver.quit();
      } finally {
        if (owned && !keepProfile) {
          await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      }
    },
  };
}
