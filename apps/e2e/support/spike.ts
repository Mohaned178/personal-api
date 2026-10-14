import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Worker } from "@playwright/test";
import { waitForServiceWorker } from "./extension";

// =============================================================================================
// Spike A (M0-10) test contract: MV3 lifecycle prototype.
//
// The prototype is a THROWAWAY WXT package at `spikes/mv3-lifecycle` (pnpm workspace member,
// NOT part of `apps/extension`). The e2e tests load its build output
// `spikes/mv3-lifecycle/.output/chrome-mv3` and know nothing else about it. Everything the tests
// rely on is below; the builder must provide exactly this and nothing more is assumed.
//
// 1. Manifest: MV3, background service worker, permissions limited to what capture needs
//    (tabs, idle, storage, alarms). No host_permissions, no content_scripts: capture must work from
//    chrome.tabs / chrome.windows / chrome.idle alone, like the shipped extension.
//
// 2. The service worker script assigns this object to `globalThis.__spike` at TOP LEVEL, on every
//    worker start (so it exists as soon as the worker runs, also after a kill + revive). Every
//    method is stateless in memory: it reads the persisted state (IndexedDB / chrome.storage), so
//    the answer is the same after a kill. `evaluate()` calls resolve with plain JSON.
//
//      interface SpikeApi {
//        bootId: string;                      // random per worker start, never persisted
//        queueDump(): Promise<SpikeEvent[]>;  // whole persisted queue, capture order, NOT drained
//        segments(): Promise<SpikeSegment[]>; // CLOSED focus segments only, ordered by startedAt
//        clear(): Promise<void>;              // empties the queue, the closed segments AND any open segment
//      }
//
// 3. Event semantics (this is the behavior under test):
//    - One `page_visited` per completed top-level navigation of an http(s) page (`status:
//      'complete'` of chrome.tabs.onUpdated, or equivalent). Exactly one per navigation: no
//      duplicates, none dropped. Other event types (`tab_opened`, `focus_started`, ...) may
//      exist; tests only look at `type === 'page_visited'` and ignore the rest.
//    - `domain` is the hostname without port ("127.0.0.1"), `path` is the pathname only. Query
//      strings and fragments are never stored (CLAUDE.md invariant 3).
//    - `id` is a uuid generated at capture time; `ts` is epoch milliseconds at capture.
//    - Non-http(s) pages (about:blank, chrome-extension://, data:) never produce page_visited and
//      never produce a focus segment.
//
// 4. Focus segment semantics: a segment opens when an http(s) tab is the active tab of the
//    focused window, and closes on tab switch, navigation away, window focus change (including
//    focus moving to another window whose active tab is not http(s)) and browser/worker restart
//    recovery. `startedAt`/`endedAt` are epoch ms, `durationMs === endedAt - startedAt`, and a
//    single segment is capped at 30 minutes. The OPEN segment must be persisted (it survives a
//    worker kill and a browser restart); `segments()` lists closed ones only.
//    After a browser restart the stale open segment from before is closed (endedAt = the last
//    moment the prototype knew the browser was alive, capped), never extended over the time the
//    browser was down, and never dropped.
//
// Idle (60 s) and screen lock are NOT covered by automated tests (no headless way to trigger
// them); they follow docs/spikes/mv3-lifecycle-manual-protocol.md.
//
// Headless limitation for blur: real OS-level window blur (focus moving to another application,
// `chrome.windows.WINDOW_ID_NONE`) cannot be produced in headless Chromium. The tests use the
// closest real event: `chrome.windows.create({ focused: true })` of a second window, which fires
// `chrome.windows.onFocusChanged` with that window (verified in new headless on Windows). Its only
// tab is about:blank, so a correct implementation closes the segment of the first window.
// =============================================================================================

export interface SpikeEvent {
  id: string;
  type: string;
  domain: string;
  path: string;
  ts: number;
}

/** Same fields as the planned `browser.focus_segment` event, timestamps as epoch ms. */
export interface SpikeSegment {
  domain: string;
  path: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface SpikeApi {
  bootId: string;
  queueDump(): Promise<SpikeEvent[]>;
  segments(): Promise<SpikeSegment[]>;
  clear(): Promise<void>;
}

/** Build output of the throwaway prototype. Built by `pnpm --filter ... build` (see the task). */
export const SPIKE_EXTENSION_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../spikes/mv3-lifecycle/.output/chrome-mv3",
);

export interface LaunchedSpike {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  /** Closes the browser. Deletes the profile unless `keepProfile` is set. */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

/**
 * Like `launchExtension` (support/extension.ts) but loads the spike build. Pass `userDataDir` to
 * relaunch on an existing profile (browser restart). Fails with a clear message when the spike has
 * not been built, so a missing prototype is reported as exactly that.
 */
export async function launchSpike(options: { userDataDir?: string } = {}): Promise<LaunchedSpike> {
  if (!existsSync(join(SPIKE_EXTENSION_PATH, "manifest.json"))) {
    throw new Error(
      `Spike A prototype is not built: ${SPIKE_EXTENSION_PATH}/manifest.json is missing ` +
        "(expected the WXT package at spikes/mv3-lifecycle).",
    );
  }
  const owned = options.userDataDir === undefined;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "pa-spike-")));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${SPIKE_EXTENSION_PATH}`,
      `--load-extension=${SPIKE_EXTENSION_PATH}`,
    ],
  });
  const worker = await waitForServiceWorker(context);
  return {
    context,
    extensionId: new URL(worker.url()).hostname,
    userDataDir,
    close: async ({ keepProfile = false } = {}) => {
      await context.close();
      if (owned && !keepProfile) {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}

// The helpers below call `worker.evaluate`, which HANGS while the worker is stopped. Only call them
// after `startServiceWorker` / `waitForServiceWorker` returned.

export const queueDump = (worker: Worker): Promise<SpikeEvent[]> =>
  worker.evaluate(() => (globalThis as unknown as { __spike: SpikeApi }).__spike.queueDump());

export const pageVisits = async (worker: Worker): Promise<SpikeEvent[]> =>
  (await queueDump(worker)).filter((event) => event.type === "page_visited");

export const closedSegments = (worker: Worker): Promise<SpikeSegment[]> =>
  worker.evaluate(() => (globalThis as unknown as { __spike: SpikeApi }).__spike.segments());

export const clearSpike = (worker: Worker): Promise<void> =>
  worker.evaluate(() => (globalThis as unknown as { __spike: SpikeApi }).__spike.clear());

export const bootIdOf = (worker: Worker): Promise<string> =>
  worker.evaluate(() => (globalThis as unknown as { __spike: SpikeApi }).__spike.bootId);

/**
 * Moves OS focus away from the window the test pages live in, as far as headless allows: opens a
 * second, focused window that only holds about:blank. Fires `chrome.windows.onFocusChanged`.
 */
export async function blurBrowserWindow(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    await chrome.windows.create({ url: "about:blank", focused: true });
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
