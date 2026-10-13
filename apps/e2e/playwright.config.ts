import { defineConfig } from "@playwright/test";

// One persistent browser context per test, launched by the fixture in support/fixtures.ts.
// Extensions only load in a persistent context, so there is no shared `browser` instance.
// Workers stay at 1: the service-worker kill tests must not compete for CPU, which keeps
// timing assertions (M0-10) stable.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
