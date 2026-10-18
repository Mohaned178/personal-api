import { rm } from "node:fs/promises";
import {
  killServiceWorker,
  launchExtension,
  serviceWorkerStatus,
  startServiceWorker,
  waitForServiceWorker,
  wakeServiceWorker,
} from "../support/extension";
import { expect, test } from "../support/fixtures";

test("loads the extension and exposes the expected manifest @smoke", async ({
  extension,
  serviceWorker,
}) => {
  expect(extension.extensionId).toMatch(/^[a-p]{32}$/);
  expect(serviceWorker.url()).toBe(`chrome-extension://${extension.extensionId}/background.js`);

  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(["tabs", "idle", "storage", "alarms"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
});

test("reads and writes chrome.storage.local from the service worker", async ({ serviceWorker }) => {
  const value = { n: 1, nested: { list: ["a", "b"] } };
  await serviceWorker.evaluate((v) => chrome.storage.local.set({ probe: v }), value);
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get("probe"));
  expect(stored).toEqual({ probe: value });
});

test("kills the service worker over CDP, and it revives on the next event with storage intact", async ({
  extension,
  serviceWorker,
}) => {
  const { context, extensionId } = extension;
  await serviceWorker.evaluate(() => chrome.storage.local.set({ survivor: "still here" }));
  expect(await serviceWorkerStatus(context)).toBe("running");

  await killServiceWorker(context);
  expect(await serviceWorkerStatus(context)).toBe("stopped");
  // Nothing wakes it by itself.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await serviceWorkerStatus(context)).toBe("stopped");

  const revived = await wakeServiceWorker(context, extensionId);
  expect(await serviceWorkerStatus(context)).toBe("running");
  expect(await revived.evaluate(() => chrome.storage.local.get("survivor"))).toEqual({
    survivor: "still here",
  });
});

test("can kill and explicitly restart the service worker repeatedly", async ({ extension }) => {
  const { context, extensionId } = extension;
  let worker = await waitForServiceWorker(context);
  for (let i = 0; i < 3; i++) {
    await worker.evaluate((n) => chrome.storage.local.set({ round: n }), i);
    await killServiceWorker(context);
    expect(await serviceWorkerStatus(context)).toBe("stopped");
    worker = await startServiceWorker(context, extensionId);
    expect(await worker.evaluate(() => chrome.storage.local.get("round"))).toEqual({ round: i });
  }
});

test("reaches the local fixture site from a page", async ({ extension, site }) => {
  const page = await extension.context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.getByRole("heading", { name: "Fixture home" })).toBeVisible();
  await page.getByRole("link", { name: "/a" }).click();
  await expect(page).toHaveURL(`${site.origin}/a`);
  await expect(page.getByRole("heading", { name: "Fixture page A" })).toBeVisible();
  const missing = await page.request.get(`${site.origin}/nope`);
  expect(missing.status()).toBe(404);
});

test("keeps chrome.storage.local across a browser restart on the same profile", async () => {
  const first = await launchExtension();
  try {
    const worker = await waitForServiceWorker(first.context);
    await worker.evaluate(() => chrome.storage.local.set({ persisted: true }));
    await first.close({ keepProfile: true });

    const second = await launchExtension({ userDataDir: first.userDataDir });
    try {
      expect(second.extensionId).toBe(first.extensionId);
      const restarted = await waitForServiceWorker(second.context);
      expect(await restarted.evaluate(() => chrome.storage.local.get("persisted"))).toEqual({
        persisted: true,
      });
    } finally {
      await second.close();
    }
  } finally {
    await rm(first.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
