import type { Page, Worker } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LaunchedExtension } from "./extension";
import type { LaunchedFirefoxExtension } from "./firefox";
import type { StoredEvent } from "./stack";

// Shared by the Chromium and Firefox pairing specs (M2-08).

// Storage keys and the alarm the extension owns. They are pinned by the extension's own unit
// tests (apps/extension/lib/connect.ts, allow-list.ts, queue/constants.ts); a rename there must
// change them here too.
export const CONNECTION_KEY = "connection";
export const ALLOW_LIST_KEY = "allowList";
export const FLUSH_RETRY_ALARM = "pa-flush-retry";

export interface StoredConnection {
  serverOrigin: string;
  ingestKey: string;
  integrationId: string;
  integrationName: string;
}

/**
 * Pairs through the real popup form, opened in a tab (`popup.html?tab=1`, the same page the toolbar
 * popup links to). The click is a trusted user gesture, which `permissions.request` needs.
 */
export async function pairThroughPopup(
  extension: LaunchedExtension,
  serverOrigin: string,
  pairingCode: string,
): Promise<void> {
  const page: Page = await extension.context.newPage();
  try {
    await page.goto(`chrome-extension://${extension.extensionId}/popup.html?tab=1`);
    await page.locator("#server-url").fill(serverOrigin);
    await page.locator("#pairing-code").fill(pairingCode);
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Connected.");
    await expect(page.locator("#connected-view")).toBeVisible();
  } finally {
    await page.close();
  }
}

/** The temporary M2-07 allow list. There is no popup editor, so the tests seed it directly. */
export async function seedAllowListChromium(worker: Worker, domains: string[]): Promise<void> {
  await worker.evaluate((args) => chrome.storage.local.set({ [args.key]: args.domains }), {
    key: ALLOW_LIST_KEY,
    domains,
  });
}

export async function readConnectionChromium(worker: Worker): Promise<unknown> {
  return worker.evaluate(
    (key) => chrome.storage.local.get(key).then((stored) => stored[key] as unknown),
    CONNECTION_KEY,
  );
}

/**
 * Makes the extension flush its queue now instead of at the next 30 s heartbeat: the flusher also
 * runs on its one-shot retry alarm, and an unpacked extension may use a near-term `when`. A flush
 * that is still inside a failure backoff does nothing, exactly as in production.
 */
export async function triggerFlushChromium(worker: Worker): Promise<void> {
  await worker.evaluate(
    (name) => chrome.alarms.create(name, { when: Date.now() + 500 }),
    FLUSH_RETRY_ALARM,
  );
}

export async function seedAllowListFirefox(
  firefox: LaunchedFirefoxExtension,
  domains: string[],
): Promise<void> {
  await firefox.storageSet({ [ALLOW_LIST_KEY]: domains });
}

// The extension's queue database (apps/extension/lib/queue/store.ts and constants.ts). The queue is
// owner-scoped: the flusher only sends rows stamped with the current connection's owner, and
// `connect()` records that owner. Pinned here like the keys above; a change there must change this.
const QUEUE_DB_NAME = "personal-api";
const QUEUE_DB_VERSION = 1;

/**
 * Records the queue owner the way `connect()` does (`store.setOwner`), for the Firefox spec, which
 * writes the connection straight into storage instead of clicking through the popup. Runs inside the
 * event page, whose IndexedDB is the extension's own. Call it BEFORE any event is captured: rows
 * queued earlier would be unowned and never sent. If the database does not exist yet it is created
 * with the same schema the extension uses (version 1), so the extension opens it unchanged.
 */
export async function setQueueOwnerFirefox(
  firefox: LaunchedFirefoxExtension,
  owner: { serverOrigin: string; integrationId: string },
): Promise<void> {
  await firefox.evaluateInBackground(
    `const [name, version, owner] = arguments;
     return (async () => {
     const db = await new Promise((resolve, reject) => {
       const request = indexedDB.open(name, version);
       request.onupgradeneeded = () => {
         const created = request.result;
         created.createObjectStore("state");
         created
           .createObjectStore("queue", { keyPath: "seq", autoIncrement: true })
           .createIndex("queuedAt", "queuedAt");
         created.createObjectStore("meta");
       };
       request.onsuccess = () => resolve(request.result);
       request.onerror = () => reject(request.error);
     });
     try {
       await new Promise((resolve, reject) => {
         const tx = db.transaction(["meta"], "readwrite");
         tx.objectStore("meta").put(
           { serverOrigin: owner.serverOrigin, integrationId: owner.integrationId },
           "owner",
         );
         tx.oncomplete = () => resolve(undefined);
         tx.onerror = () => reject(tx.error);
         tx.onabort = () => reject(tx.error);
       });
     } finally {
       db.close();
     }
     })()`,
    [QUEUE_DB_NAME, QUEUE_DB_VERSION, owner],
  );
}

export async function triggerFlushFirefox(firefox: LaunchedFirefoxExtension): Promise<void> {
  await firefox.evaluateInBackground(
    `return browser.alarms.create(${JSON.stringify(FLUSH_RETRY_ALARM)}, { when: Date.now() + 500 })`,
  );
}

/** `browser.page_visited` rows only (tab and focus events are not what these tests count). */
export const pageVisits = (events: StoredEvent[]): StoredEvent[] =>
  events.filter((event) => event.type === "browser.page_visited");

/** The `path` of every page visit with this domain, in stored order. */
export const visitedPaths = (events: StoredEvent[], domain: string): string[] =>
  pageVisits(events)
    .filter((event) => event.data.domain === domain)
    .map((event) => String(event.data.path));

/** Occurrences of each path (a duplicate shows up as a count above 1). */
export function countByPath(paths: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of paths) counts[path] = (counts[path] ?? 0) + 1;
  return counts;
}
