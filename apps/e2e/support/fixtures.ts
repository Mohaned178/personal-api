import { test as base, expect, type Worker } from "@playwright/test";
import { type LaunchedExtension, launchExtension, waitForServiceWorker } from "./extension";
import { type FixtureSite, startFixtureSite } from "./fixture-site";
import { type E2eStack, startStack } from "./stack";

interface TestFixtures {
  /** Fresh browser profile with the built extension loaded; closed and deleted after the test. */
  extension: LaunchedExtension;
  /** The extension's service worker (running when the test starts). */
  serviceWorker: Worker;
}

interface WorkerFixtures {
  /** Local static site on an ephemeral loopback port. Shared by all tests in the worker. */
  site: FixtureSite;
  /** Real Postgres + the built API (M2-08). Started on first use; one per worker. */
  stack: E2eStack;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here.
    async ({}, use) => {
      const stack = await startStack();
      try {
        await use(stack);
      } finally {
        await stack.stop();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  site: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here.
    async ({}, use) => {
      const site = await startFixtureSite();
      await use(site);
      await site.close();
    },
    { scope: "worker" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here.
  extension: async ({}, use) => {
    const extension = await launchExtension();
    try {
      await use(extension);
    } finally {
      await extension.close();
    }
  },
  serviceWorker: async ({ extension }, use) => {
    await use(await waitForServiceWorker(extension.context));
  },
});

export { expect };
