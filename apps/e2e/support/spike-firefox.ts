import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";
import type { SpikeEvent, SpikeSegment } from "./spike";

// =============================================================================================
// Spike C (M2-00b) test contract: Firefox MV3 event page lifecycle.
//
// Implemented with Selenium + geckodriver (see "How it works" below). apps/e2e/tests/
// spike-mv3-firefox.spec.ts is the only consumer and knows nothing about Selenium.
//
// WHY NOT PLAYWRIGHT: Playwright's Firefox is a patched build that cannot load WebExtensions, and
// it cannot drive Selenium. The spec still runs under the Playwright TEST RUNNER (reuses the
// fixture site and the repo's conventions) but never uses a Playwright browser.
//
// The prototype under test is the SAME throwaway package as Spike A (`spikes/mv3-lifecycle`),
// built for Firefox with `wxt build -b firefox --mv3` into `.output/firefox-mv3`. The contract of
// the background's `globalThis.__spike` object (queueDump, segments, clear, bootId) and the
// event/segment semantics are exactly the ones documented in support/spike.ts (sections 2 to 4),
// with "service worker" read as "event page".
//
// ---- Harness requirements -------------------------------------------------------------------
//
// H1. Headless in CI (Ubuntu) and runnable on a dev machine. Firefox + geckodriver are located
//     the usual way (selenium-manager may download geckodriver). Each launch uses its own fresh
//     profile directory unless `userDataDir` is given.
//
// H2. The extension is installed with a STABLE add-on id (the manifest's
//     `browser_specific_settings.gecko.id`, asserted by the spike's manifest test) and a pinned
//     moz-extension UUID, so that after a browser restart on the SAME profile the extension's
//     IndexedDB is the same database. `extensionUuid` is that UUID; the spec asserts it is
//     identical across a relaunch.
//
// H3. Observation must be NON-INTRUSIVE. Reading state (`queueDump`, `segments`, `bootId`, ...)
//     must not itself create page_visited events, focus segments, tabs, or focus changes. In
//     particular do not read by opening a moz-extension:// page in a tab: that fires
//     `tabs.onUpdated`/`onActivated` and would pollute the very thing under test. Run the read in
//     the background context (for example geckodriver's chrome context, or a window-less probe).
//
// H4. Reads that need a running background MAY start it (the way `startBackground` does), but
//     must do so without generating any tabs/windows/idle event.
//
// ---- How it works ---------------------------------------------------------------------------
//
// - geckodriver runs with `--allow-system-access` (Firefox 138+ only allows Marionette's chrome
//   context with it), Firefox with `-headless -profile <dir>`, so the profile is used in place and
//   survives a quit (geckodriver would otherwise copy it to a throwaway directory).
// - The pref `extensions.webextensions.uuids` pins the moz-extension UUID of the add-on id.
// - The build is installed as a TEMPORARY add-on (Selenium `installAddon(dir, true)`, which zips
//   the directory; geckodriver calls `AddonManager.installTemporaryAddon`, the same call web-ext
//   makes over the remote debugging protocol). Release Firefox refuses unsigned add-ons otherwise.
//   A temporary add-on is gone after a restart, so a relaunch on the same profile installs it
//   again: the background's first start after a relaunch is an install, not `runtime.onStartup`.
// - Background control and reads run privileged script in Marionette's CHROME context:
//   `ExtensionParent.GlobalManager.getExtension(id)` gives Firefox's own `Extension` object.
//   * suspend: `extension.terminateBackground()`, the very function Firefox's event page idle
//     timer calls when `extensions.background.idle.timeout` (30 s) expires, called on demand with
//     the default options. It tears the background page down (state "stopped", the page's window
//     and everything in memory are gone) and re-primes the persistent listeners. Like the timer,
//     it declines (and restarts the idle timer) while DevTools is attached or while a promise
//     returned by one of the page's listeners is pending (Firefox's `ext-backgroundPage.js`).
//     After such a decline the timer asks again a full idle period later; the harness waits only
//     until the listener promises it declined for have settled, then asks again. What is skipped
//     is the 30 s wait since the last event, so the page is terminated far more often and at far
//     less convenient moments than Firefox ever would on its own (between the events of one
//     navigation, a few ms after a commit, while a page is loading).
//   * start: `extension.wakeupBackground()`, which starts the page the way a primed event does,
//     without dispatching any API event.
//   * running: `extension.backgroundState === "running"`.
//   * reads: Marionette's `MarionetteCommands` window actor of the background page's window
//     global evaluates `globalThis.__spike...` INSIDE the event page (no tab, no window, no
//     moz-extension:// page is opened).
// - Tabs and focus are driven like a user would, through WebDriver content commands: a tab is a
//   WebDriver window handle, `activate` is Switch To Window (selects the tab and focuses its
//   window). `blurWindow` is the one exception: like Spike A, the background opens the second
//   window with `browser.windows.create({ focused: true })` (see blurWindow below for why).
//
// ---- Semantics of each helper ---------------------------------------------------------------
//
// suspendBackground(): FORCES the event page to be terminated, like Firefox does after
//   `extensions.background.idle.timeout` (default 30 s), but on demand. It must NOT be
//   `runtime.reload()` (that restarts it immediately and re-runs the startup path), must not close
//   tabs, and must not fire tabs/windows/idle events. Resolves only once the browser reports the
//   background as not running (`isBackgroundRunning() === false`). All in-memory state of the
//   event page is gone; IndexedDB and storage survive. If it is already suspended it resolves.
//   It honours Firefox's listener keep-alive exactly as described under "How it works".
//
// startBackground(): starts a suspended event page explicitly, with no browser event, and resolves
//   once it is running (its top level ran, so `__spike` exists and `bootId` is new). A no-op that
//   resolves when the page is already running (an event may have woken it first).
//
// waitForBackground(timeout?): resolves once the background is running WITHOUT starting it. Used
//   after an event (a navigation, a tab switch) that must wake the page by itself: top-level
//   listeners are what makes that work. Rejects after `timeout` ms (default 15 000).
//
// isBackgroundRunning(): true while the event page is alive according to the browser.
//
// openTab(url): opens a NEW tab in the (single, focused) main window, navigates it to `url`,
//   waits for the load to finish, leaves it as the active tab.
//
// navigate(tab, url, { wait }): loads `url` in `tab` (activating it first if it is not the current
//   tab). `wait` defaults to true (resolves after the load finished). With `wait: false` it
//   resolves as soon as the navigation was initiated, while the page is still loading (the "kill
//   while the next navigation is loading" pattern). Pair it with `waitForLoad`.
//
// waitForLoad(tab): resolves when the tab's current navigation finished.
//
// activate(tab): makes `tab` the active tab of the main window (a real tab switch: fires
//   `tabs.onActivated`). Resolves once the switch happened.
//
// blurWindow(): moves focus away from the main window as far as headless allows: opens a second,
//   focused window holding only about:blank (fires `windows.onFocusChanged`). Resolves once that
//   window exists and is focused.
//
// windowFocused(): whether the MAIN window is what `browser.windows.getLastFocused()` reports as
//   the focused window, as seen from the background (`focused === true` and its id is the main
//   window's). The capture design is level-triggered from getLastFocused(), so it must be true
//   whenever one of the main window's tabs was just activated, and false after `blurWindow()`.
//   (Measured finding: headless Firefox reports the blur window itself as last focused with
//   `focused: true`, the same as a user switching to another browser window, so the bare flag
//   would stay true after a blur. What the design depends on is that the MAIN window is no longer
//   the focused one, which is what this reports.)
//
// queueDump() / pageVisits() / segments() / bootId() / clear(): the SpikeApi of support/spike.ts,
//   stateless and persisted, answered by the background (bootId is new on every background start
//   and is never persisted).
//
// close({ keepProfile }): quits the browser (graceful, like a user closing it). Deletes the
//   profile unless `keepProfile` or the profile was passed in by the caller.
// =============================================================================================

/** Build output of the throwaway prototype for Firefox (`wxt build -b firefox --mv3`). */
export const SPIKE_FIREFOX_EXTENSION_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../spikes/mv3-lifecycle/.output/firefox-mv3",
);

/**
 * moz-extension UUID pinned for the spike's add-on id (pref `extensions.webextensions.uuids`).
 * A fixed random value, no meaning: it only has to be the same on every launch.
 */
const PINNED_EXTENSION_UUID = "6d1c3c5e-6b0c-4f43-9b7e-2f0a5d8e1c11";

const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 25;

/** Opaque handle of a browser tab (the WebDriver window handle). */
export interface FirefoxTab {
  readonly handle: string;
}

export interface LaunchedFirefoxSpike {
  /** Profile directory; pass it to `launchFirefoxSpike` again to simulate a browser restart. */
  readonly userDataDir: string;
  /** The extension's moz-extension host UUID (stable across relaunches of the same profile). */
  readonly extensionUuid: string;

  openTab(url: string): Promise<FirefoxTab>;
  navigate(tab: FirefoxTab, url: string, options?: { wait?: boolean }): Promise<void>;
  waitForLoad(tab: FirefoxTab): Promise<void>;
  activate(tab: FirefoxTab): Promise<void>;
  blurWindow(): Promise<void>;
  windowFocused(): Promise<boolean>;

  /**
   * `harsh` is not part of the test contract (ad-hoc measurements for the ADR only): it ignores
   * Firefox's listener keep-alive and terminates even while a listener's promise is pending,
   * like a crash at that instant.
   */
  suspendBackground(options?: { harsh?: boolean }): Promise<void>;
  startBackground(): Promise<void>;
  waitForBackground(options?: { timeout?: number }): Promise<void>;
  isBackgroundRunning(): Promise<boolean>;

  bootId(): Promise<string>;
  queueDump(): Promise<SpikeEvent[]>;
  pageVisits(): Promise<SpikeEvent[]>;
  segments(): Promise<SpikeSegment[]>;
  clear(): Promise<void>;
  /** Not part of the test contract: the background's counters (`__spike.diagnostics()`), for the ADR. */
  diagnostics(): Promise<Record<string, number>>;

  /** Closes the browser. Deletes the profile unless `keepProfile` is set. */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

/** The add-on id the spike's Firefox manifest pins (`browser_specific_settings.gecko.id`). */
function readAddonId(): string {
  const manifestPath = join(SPIKE_FIREFOX_EXTENSION_PATH, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Spike C prototype is not built for Firefox: ${manifestPath} is missing ` +
        "(build it with `pnpm --filter @personal-api/spike-mv3-lifecycle build`).",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    browser_specific_settings?: { gecko?: { id?: unknown } };
  };
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (typeof id !== "string") {
    throw new Error(`${manifestPath} has no browser_specific_settings.gecko.id`);
  }
  return id;
}

/** Operations run in Marionette's chrome context (privileged, in Firefox's parent process). */
type ChromeOp = "state" | "uuid" | "suspend" | "start" | "wait" | "read";

// One privileged script for every operation. Arguments: add-on id, operation, operation argument,
// Marionette's resolve callback. Resolves with `{ value }` or `{ error }` (a message only).
const CHROME_SCRIPT = `
const [addonId, op, arg, timeoutMs, done] = arguments;
(async () => {
  const { ExtensionParent } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionParent.sys.mjs",
  );
  const extension = ExtensionParent.GlobalManager.getExtension(addonId);
  if (!extension) throw new Error("the spike add-on is not installed");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + timeoutMs;
  const state = () => extension.backgroundState;
  const evaluate = (script) =>
    extension.backgroundContext.browsingContext.currentWindowGlobal
      .getActor("MarionetteCommands")
      .executeScript(script, [], { sandboxName: null, newSandbox: false, file: "spike-firefox", line: 0 });
  const ready = async () =>
    state() === "running" &&
    !!extension.backgroundContext &&
    (await evaluate("return typeof globalThis.__spike === 'object'").catch(() => false));
  switch (op) {
    case "state":
      return state();
    case "uuid":
      return WebExtensionPolicy.getByID(addonId).mozExtensionHostname;
    case "suspend":
      // The idle timer's own termination path, called on demand. It declines while a promise
      // returned by one of the page's listeners is pending (and while DevTools is attached),
      // restarting the idle timer instead; Firefox asks again only a full idle period later, by
      // which time those listener promises have settled. The harness compresses that period to
      // "until the promises it declined for settled" (bounded by the deadline). arg "harsh" asks
      // again at once, which terminates regardless: an ad-hoc crash-like measurement only.
      while (state() !== "stopped") {
        if (Date.now() > deadline) throw new Error("background did not stop, state " + state());
        if (state() !== "running") {
          await sleep(${POLL_MS});
          continue;
        }
        // Listener promises Firefox is tracking right now (a decline clears this set).
        const pending = [...(extension.backgroundContext?.runListenerPromises ?? [])];
        await extension.terminateBackground();
        if (arg !== "harsh" && pending.length > 0 && state() === "running") {
          await Promise.race([
            Promise.allSettled(pending),
            sleep(Math.max(0, deadline - Date.now())),
          ]);
        }
      }
      return state();
    case "start":
    case "read":
      // No-op when an event already started it; otherwise start it without any API event.
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error("background did not start, state " + state());
        if (state() === "stopped") await extension.wakeupBackground();
        else await sleep(${POLL_MS});
      }
      return op === "read" ? await evaluate(arg) : state();
    case "wait":
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error("background is not running, state " + state());
        await sleep(${POLL_MS});
      }
      return state();
    default:
      throw new Error("unknown op " + op);
  }
})().then(
  (value) => done({ value }),
  (error) => done({ error: String((error && error.message) || error) }),
);
`;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Launches headless Firefox with the spike's `firefox-mv3` build installed. Pass `userDataDir` to
 * relaunch on an existing profile (browser restart). Fails with a clear message when the spike
 * has not been built for Firefox, so a missing build is reported as exactly that.
 */
export async function launchFirefoxSpike(
  options: { userDataDir?: string } = {},
): Promise<LaunchedFirefoxSpike> {
  const addonId = readAddonId();
  const owned = options.userDataDir === undefined;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "pa-spike-ff-")));

  const firefoxOptions = new Options()
    .addArguments("-headless", "-profile", userDataDir)
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [addonId]: PINNED_EXTENSION_UUID }),
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
    arg: string | null = null,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<T> => {
    await useContext(Context.CHROME);
    const result = (await driver.executeAsyncScript(CHROME_SCRIPT, addonId, op, arg, timeoutMs)) as
      | { value: T }
      | { error: string };
    if ("error" in result) throw new Error(`spike-firefox ${op}: ${result.error}`);
    return result.value;
  };

  /** Evaluates `script` (a function body) inside the event page, starting it if needed (H4). */
  const inBackground = <T>(script: string): Promise<T> => chrome<T>("read", script);

  const pendingUrl = new Map<string, string>();
  /** The WebDriver handle content commands act on; "" after a blur (focus is elsewhere). */
  let current = "";

  const switchTo = async (tab: FirefoxTab): Promise<void> => {
    await useContext(Context.CONTENT);
    await driver.switchTo().window(tab.handle);
    current = tab.handle;
  };

  const waitForLoad = async (tab: FirefoxTab): Promise<void> => {
    const expected = pendingUrl.get(tab.handle);
    if (expected === undefined) return;
    if (current !== tab.handle) await switchTo(tab);
    await useContext(Context.CONTENT);
    const deadline = Date.now() + DEFAULT_WAIT_MS;
    for (;;) {
      const state = (await driver
        .executeScript("return [document.readyState, document.URL]")
        .catch(() => null)) as [string, string] | null;
      if (state && state[0] === "complete" && state[1] === expected) return;
      if (Date.now() > deadline) throw new Error("waitForLoad: the navigation did not finish");
      await sleepMs(POLL_MS);
    }
  };

  const navigate = async (
    tab: FirefoxTab,
    url: string,
    { wait = true }: { wait?: boolean } = {},
  ): Promise<void> => {
    if (current !== tab.handle) await switchTo(tab);
    await useContext(Context.CONTENT);
    pendingUrl.set(tab.handle, new URL(url).href);
    if (wait) {
      await driver.get(url);
    } else {
      // Starts the navigation from the page and returns while the new page is still loading.
      await driver.executeScript("window.location.href = arguments[0];", url);
    }
  };

  // The browser is up: wait for the install to have started the event page.
  let extensionUuid: string;
  let mainWindowId: number;
  try {
    // Every chrome-context call bounds itself (DEFAULT_WAIT_MS or the caller's timeout).
    await driver.manage().setTimeouts({ script: 120_000 });
    await driver.installAddon(SPIKE_FIREFOX_EXTENSION_PATH, true);
    await chrome("wait");
    extensionUuid = await chrome<string>("uuid");
    // Only the main window exists at launch.
    mainWindowId = await inBackground<number>(
      "return browser.windows.getLastFocused().then((w) => w.id)",
    );
    await useContext(Context.CONTENT);
    current = await driver.getWindowHandle();
  } catch (error) {
    await driver.quit().catch(() => {});
    if (owned) await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  const queueDump = (): Promise<SpikeEvent[]> =>
    inBackground<SpikeEvent[]>("return globalThis.__spike.queueDump()");

  return {
    userDataDir,
    extensionUuid,

    openTab: async (url) => {
      if (current === "") {
        throw new Error("openTab: activate a main-window tab first (focus is on the blur window)");
      }
      await useContext(Context.CONTENT);
      await driver.switchTo().newWindow("tab");
      const tab = { handle: await driver.getWindowHandle() };
      current = tab.handle;
      await navigate(tab, url);
      return tab;
    },
    navigate,
    waitForLoad,
    activate: switchTo,
    blurWindow: async () => {
      // Same as Spike A: the second window is opened by the extension API, focused, in one step.
      // WebDriver's New Window (+ switch) was tried first: in a measured run the main window's
      // segment closed, reopened for 48 ms and closed again, i.e. focus visibly bounced back to the
      // main window while Marionette opened and switched to the new one. That bounce is the
      // harness's doing, not a user action, so the window is opened by the extension API instead.
      await inBackground<number>(
        "return browser.windows.create({ url: 'about:blank', focused: true }).then((w) => w.id)",
      );
      // The next tab command switches back to its tab (and so to the main window) explicitly.
      current = "";
    },
    windowFocused: () =>
      inBackground<boolean>(
        `return browser.windows.getLastFocused().then((w) => w.focused === true && w.id === ${mainWindowId})`,
      ),

    suspendBackground: async ({ harsh = false } = {}) => {
      await chrome("suspend", harsh ? "harsh" : null);
    },
    startBackground: async () => {
      await chrome("start");
    },
    waitForBackground: async ({ timeout = DEFAULT_WAIT_MS } = {}) => {
      await chrome("wait", null, timeout);
    },
    isBackgroundRunning: async () => (await chrome<string>("state")) === "running",

    bootId: () => inBackground<string>("return globalThis.__spike.bootId"),
    queueDump,
    pageVisits: async () => (await queueDump()).filter((event) => event.type === "page_visited"),
    segments: () => inBackground<SpikeSegment[]>("return globalThis.__spike.segments()"),
    clear: () => inBackground<void>("return globalThis.__spike.clear()"),
    diagnostics: () =>
      inBackground<Record<string, number>>("return globalThis.__spike.diagnostics()"),

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
