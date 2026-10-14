import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the manifest produced by `wxt build` (run by the package's test script).
const manifestPath = fileURLToPath(new URL("../.output/chrome-mv3/manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

describe("built MV3 manifest", () => {
  it("requests exactly the planned permissions", () => {
    expect(manifest.permissions).toEqual(["tabs", "idle", "storage", "alarms"]);
  });

  it("requests the API origin only as optional host permissions", () => {
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });

  it("is not allowed in incognito windows (invariant 3: never collect incognito tabs)", () => {
    expect(manifest.incognito).toBe("not_allowed");
  });

  it("has no host_permissions", () => {
    expect(manifest).not.toHaveProperty("host_permissions");
  });

  it("has no content_scripts", () => {
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("has no web_accessible_resources", () => {
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });
});
