import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spike C (M2-00b). Reads the manifest of `wxt build -b firefox --mv3` (the package's test script
// must build it before vitest runs). Read lazily so a missing build is reported as exactly that.
const manifestPath = fileURLToPath(
  new URL("../.output/firefox-mv3/manifest.json", import.meta.url),
);

function loadManifest(): Record<string, unknown> {
  expect(
    existsSync(manifestPath),
    `Firefox build of the spike is missing: ${manifestPath} (build with: wxt build -b firefox --mv3)`,
  ).toBe(true);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

describe("spike firefox manifest", () => {
  it("is an MV3 event page (background.scripts), not a service worker", () => {
    const manifest = loadManifest();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ scripts: ["background.js"] });
  });

  it("requests exactly the permissions the shipped extension has", () => {
    expect(loadManifest().permissions).toEqual(["tabs", "idle", "storage", "alarms"]);
  });

  it("has no host permissions, content scripts or web accessible resources", () => {
    const manifest = loadManifest();
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("has a stable gecko add-on id, so a relaunched profile keeps the extension's IndexedDB", () => {
    const manifest = loadManifest();
    const gecko = (manifest.browser_specific_settings as { gecko?: { id?: unknown } } | undefined)
      ?.gecko;
    expect(typeof gecko?.id).toBe("string");
    expect(gecko?.id).toMatch(/^[^@\s]+@[^@\s]+$/);
  });
});
