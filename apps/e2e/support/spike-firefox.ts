import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpikeEvent, SpikeSegment } from "./spike";

// =============================================================================================
// Spike C (M2-00b) test contract: Firefox MV3 event page lifecycle.
//
// STATUS: STUB. Every function below throws "not implemented". The builder replaces the bodies
// (keeping the exported names, signatures and the semantics documented here) with a
// Selenium + geckodriver implementation. apps/e2e/tests/spike-mv3-firefox.spec.ts is the only
// consumer and knows nothing about Selenium, so the spec must not need to change when this file is
// implemented. If a semantic below turns out to be impossible on Firefox, report it instead of
// weakening the spec: that is a finding for ADR 0002's Firefox section.
//
// WHY NOT PLAYWRIGHT: Playwright's Firefox is a patched build that cannot load WebExtensions, and
// it cannot drive Selenium. The spec still runs under the Playwright TEST RUNNER (reuses the
// fixture site and the repo's conventions) but never uses a Playwright browser.
//
// The prototype under test is the SAME throwaway package as Spike A (`spikes/mv3-lifecycle`),
// built for Firefox with `wxt build -b firefox --mv3` into `.output/firefox-mv3`. The builder adds
// the Firefox build script and keeps the Chromium build working. The contract of the background's
// `globalThis.__spike` object (queueDump, segments, clear, bootId) and the event/segment
// semantics are exactly the ones documented in support/spike.ts (sections 2 to 4), with
// "service worker" read as "event page".
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
// ---- Semantics of each helper ---------------------------------------------------------------
//
// suspendBackground(): FORCES the event page to be terminated, like Firefox does after
//   `extensions.background.idle.timeout` (default 30 s), but on demand. It must NOT be
//   `runtime.reload()` (that restarts it immediately and re-runs the startup path), must not close
//   tabs, and must not fire tabs/windows/idle events. Resolves only once the browser reports the
//   background as not running (`isBackgroundRunning() === false`). All in-memory state of the
//   event page is gone; IndexedDB and storage survive. If it is already suspended it resolves.
//   Suggested ways: set the idle timeout pref very low and wait, or call the extension's
//   `terminateBackground()` from the chrome context. Whichever is used, ADR 0002 must say how.
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
// navigate(tab, url, { wait }): loads `url` in `tab`. `wait` defaults to true (resolves after the
//   load finished). With `wait: false` it resolves as soon as the navigation was initiated, while
//   the page is still loading (the "kill while the next navigation is loading" pattern). Pair it
//   with `waitForLoad`.
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
// windowFocused(): the `focused` flag of `browser.windows.getLastFocused()` as seen from the
//   background. The capture design is level-triggered from this flag, so it must be true for the
//   main window whenever one of its tabs was just activated, and false after `blurWindow()`.
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

  suspendBackground(): Promise<void>;
  startBackground(): Promise<void>;
  waitForBackground(options?: { timeout?: number }): Promise<void>;
  isBackgroundRunning(): Promise<boolean>;

  bootId(): Promise<string>;
  queueDump(): Promise<SpikeEvent[]>;
  pageVisits(): Promise<SpikeEvent[]>;
  segments(): Promise<SpikeSegment[]>;
  clear(): Promise<void>;

  /** Closes the browser. Deletes the profile unless `keepProfile` is set. */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

/**
 * Launches headless Firefox with the spike's `firefox-mv3` build installed. Pass `userDataDir` to
 * relaunch on an existing profile (browser restart). Must fail with a clear message when the
 * spike has not been built for Firefox, so a missing build is reported as exactly that.
 */
export async function launchFirefoxSpike(
  _options: { userDataDir?: string } = {},
): Promise<LaunchedFirefoxSpike> {
  throw new Error(
    "not implemented: launchFirefoxSpike (Spike C / M2-00b needs the Selenium + geckodriver harness in apps/e2e/support/spike-firefox.ts)",
  );
}
