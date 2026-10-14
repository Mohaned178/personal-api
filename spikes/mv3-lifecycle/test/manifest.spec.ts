import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the manifest produced by `wxt build` (run by the package's test script).
const manifestPath = fileURLToPath(new URL("../.output/chrome-mv3/manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

describe("spike manifest", () => {
  it("requests exactly the permissions the shipped extension has", () => {
    expect(manifest.permissions).toEqual(["tabs", "idle", "storage", "alarms"]);
  });

  it("has no host permissions, content scripts or web accessible resources", () => {
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("runs as an MV3 service worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js" });
  });
});
