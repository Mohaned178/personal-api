import { defineConfig } from "@playwright/test";

// Firefox specs (Selenium + geckodriver, see support/spike-firefox.ts). Playwright is only the
// test RUNNER here: no Playwright browser is launched. Kept apart from playwright.config.ts so the
// Chromium run (`test:e2e:edge`) never needs Firefox or geckodriver.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*-firefox.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
});
