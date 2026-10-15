import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type CDPSession, chromium, type Worker } from "@playwright/test";

/** The WXT build output. `pnpm test:e2e` builds it first. */
export const EXTENSION_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../extension/.output/chrome-mv3",
);

export interface LaunchedExtension {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  /** Closes the browser. Deletes the profile unless `keepProfile` is set. */
  close(options?: { keepProfile?: boolean }): Promise<void>;
}

const extensionIdOf = (worker: Worker): string => new URL(worker.url()).hostname;

/**
 * Launch bundled Chromium (not branded Chrome, which ignores --load-extension since 137) in new
 * headless mode with the built extension. Pass `userDataDir` to reuse a profile (browser restart).
 */
export async function launchExtension(
  options: { userDataDir?: string; extensionPath?: string } = {},
): Promise<LaunchedExtension> {
  const extensionPath = options.extensionPath ?? EXTENSION_PATH;
  const owned = options.userDataDir === undefined;
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), "pa-e2e-")));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // 'chromium' selects new headless mode (extensions work). Never use the old headless shell.
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = await waitForServiceWorker(context);
  return {
    context,
    extensionId: extensionIdOf(worker),
    userDataDir,
    close: async ({ keepProfile = false } = {}) => {
      await context.close();
      if (owned && !keepProfile) {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Service worker control through CDP.
//
// Playwright has no API to stop a service worker, and `context.newCDPSession` only accepts pages.
// What works (verified on Playwright 1.63 / bundled Chromium, Windows and headless): open a CDP
// session on any page of the context, enable the `ServiceWorker` domain (it reports every worker
// version, including the extension's, as `workerVersionUpdated` events) and call
// `ServiceWorker.stopWorker({ versionId })`. The worker keeps its target id when it revives, so
// the Playwright `Worker` handle stays valid after a restart, but:
//   - `worker.evaluate()` HANGS while the worker is stopped. Never call it before checking status.
//   - Playwright never emits `close`/`serviceworker` for the stop or the restart, and
//     `context.serviceWorkers()` keeps returning the stale handle. Use CDP status for truth.
// ---------------------------------------------------------------------------------------------

export type ServiceWorkerStatus = "stopped" | "starting" | "running" | "stopping" | "absent";

interface SwVersion {
  versionId: string;
  scriptURL: string;
  runningStatus: Exclude<ServiceWorkerStatus, "absent">;
}

interface VersionUpdatedEvent {
  versions: SwVersion[];
}

const EXTENSION_SCHEME = "chrome-extension://";

/**
 * Runs `fn` with a CDP session whose ServiceWorker domain is enabled. Reuses the context's first
 * page, because opening a new tab would fire chrome.tabs events at the extension under test.
 */
async function withServiceWorkerDomain<T>(
  context: BrowserContext,
  fn: (api: {
    cdp: CDPSession;
    /** Resolves with the extension worker's version once `predicate` holds (checks the latest event). */
    waitForVersion(predicate: (v: SwVersion) => boolean, timeout: number): Promise<SwVersion>;
  }) => Promise<T>,
): Promise<T> {
  const existing = context.pages()[0];
  const page = existing ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  let latest: SwVersion | undefined;
  const waiters = new Set<() => void>();
  cdp.on("ServiceWorker.workerVersionUpdated", (event: VersionUpdatedEvent) => {
    const extensionVersions = event.versions.filter((v) =>
      v.scriptURL.startsWith(EXTENSION_SCHEME),
    );
    const last = extensionVersions[extensionVersions.length - 1];
    if (last) latest = last;
    for (const wake of waiters) wake();
  });
  try {
    await cdp.send("ServiceWorker.enable");
    return await fn({
      cdp,
      waitForVersion: async (predicate, timeout) => {
        const deadline = Date.now() + timeout;
        for (;;) {
          if (latest && predicate(latest)) return latest;
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error(
              `Timed out waiting for service worker state (last: ${latest?.runningStatus ?? "none"})`,
            );
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, remaining);
            function done() {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
          });
        }
      },
    });
  } finally {
    await cdp.send("ServiceWorker.disable").catch(() => {});
    await cdp.detach().catch(() => {});
    if (!existing) await page.close().catch(() => {});
  }
}

/** The extension service worker's lifecycle state according to the browser (not Playwright). */
export async function serviceWorkerStatus(context: BrowserContext): Promise<ServiceWorkerStatus> {
  return withServiceWorkerDomain(context, async ({ waitForVersion }) => {
    try {
      return (await waitForVersion(() => true, 2_000)).runningStatus;
    } catch {
      return "absent";
    }
  });
}

/**
 * Wait until the extension's service worker is running and return its Playwright handle.
 * Works at launch and after a kill (the revive needs an event or `startServiceWorker`).
 */
export async function waitForServiceWorker(
  context: BrowserContext,
  options: { timeout?: number } = {},
): Promise<Worker> {
  const timeout = options.timeout ?? 15_000;
  const deadline = Date.now() + timeout;
  const isExtensionWorker = (w: Worker) => w.url().startsWith(EXTENSION_SCHEME);
  const worker =
    context.serviceWorkers().find(isExtensionWorker) ??
    (await context.waitForEvent("serviceworker", { predicate: isExtensionWorker, timeout }));
  for (;;) {
    if ((await serviceWorkerStatus(context)) === "running") return worker;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the service worker to run");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Stops the extension's service worker the way Chrome does when it idles out (all in-memory state
 * is lost) and resolves once the browser reports it `stopped`. The worker does NOT restart by
 * itself: it revives on the next extension event (see `wakeServiceWorker`) or `startServiceWorker`.
 */
export async function killServiceWorker(
  context: BrowserContext,
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 10_000;
  await withServiceWorkerDomain(context, async ({ cdp, waitForVersion }) => {
    const current = await waitForVersion(() => true, timeout);
    if (current.runningStatus === "stopped") return;
    await cdp.send("ServiceWorker.stopWorker", { versionId: current.versionId });
    await waitForVersion((v) => v.runningStatus === "stopped", timeout);
  });
}

/** Revive a stopped worker explicitly through CDP, without generating any extension event. */
export async function startServiceWorker(
  context: BrowserContext,
  extensionId: string,
  options: { timeout?: number } = {},
): Promise<Worker> {
  await withServiceWorkerDomain(context, async ({ cdp }) => {
    await cdp.send("ServiceWorker.startWorker", { scopeURL: `${EXTENSION_SCHEME}${extensionId}/` });
  });
  return waitForServiceWorker(context, options);
}

/**
 * Revive a stopped worker with a real extension event: an extension page sends a runtime message.
 * Chrome starts the worker to deliver it (even while no onMessage listener exists, the send fails
 * with "Receiving end does not exist" afterwards). Opens and closes one extension page, so
 * `chrome.tabs` listeners will see a tab; use `startServiceWorker` when that matters.
 */
export async function wakeServiceWorker(
  context: BrowserContext,
  extensionId: string,
  options: { timeout?: number } = {},
): Promise<Worker> {
  const page = await context.newPage();
  try {
    await page.goto(`${EXTENSION_SCHEME}${extensionId}/popup.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "e2e-wake" }).catch(() => {}));
  } finally {
    await page.close();
  }
  return waitForServiceWorker(context, options);
}
