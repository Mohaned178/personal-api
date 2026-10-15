import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchFirefoxExtension } from "../support/firefox";

// M2-00c: cheap checks of the Firefox harness itself. None of these starts a browser: the harness
// must validate the build FIRST (contract F3 in support/firefox.ts) and fail with a message that
// tells the developer what to do.

test.describe("Firefox harness: build validation", () => {
  let root: string;

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pa-ff-harness-"));
  });
  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("fails with the missing manifest path and the build command when firefox-mv3 is not built", async () => {
    const extensionPath = join(root, "not-built", "firefox-mv3");
    const userDataDir = join(root, "profile");
    const error = await launchFirefoxExtension({ extensionPath, userDataDir }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(join(extensionPath, "manifest.json"));
    expect(message).toContain("pnpm --filter extension build:firefox");
    // Failed before any browser or profile existed.
    expect(existsSync(userDataDir)).toBe(false);
  });

  test("fails naming browser_specific_settings.gecko.id when the manifest has no add-on id", async () => {
    const extensionPath = join(root, "no-id");
    const userDataDir = join(root, "profile");
    await mkdir(extensionPath, { recursive: true });
    await writeFile(
      join(extensionPath, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "x", version: "0.0.0" }),
    );
    await expect(launchFirefoxExtension({ extensionPath, userDataDir })).rejects.toThrow(
      /browser_specific_settings\.gecko\.id/,
    );
    expect(existsSync(userDataDir)).toBe(false);
  });

  test("runs Firefox headless so it works on a display-less CI runner", () => {
    // Headless cannot be observed from a running browser through the harness API, so pin the flag in
    // the launcher source (the spike harness uses the same `-headless` argument).
    const source = readFileSync(
      fileURLToPath(new URL("../support/firefox.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/["']-headless["']/);
  });
});
