import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the manifests produced by `wxt build` for both targets (run by the package's test script).
// Edge loads the chrome-mv3 build.
function readManifest(target: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../.output/${target}/manifest.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe.each(["chrome-mv3", "firefox-mv3"])("built %s manifest", (target) => {
  const manifest = readManifest(target);

  it("is manifest version 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requests exactly the planned permissions", () => {
    expect(manifest.permissions).toEqual(["tabs", "idle", "storage", "alarms", "notifications"]);
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

describe("firefox-only manifest settings", () => {
  it("declares the gecko id, minimum version and data collection", () => {
    const gecko = (readManifest("firefox-mv3").browser_specific_settings as Record<string, unknown>)
      ?.gecko as Record<string, unknown>;
    expect(gecko.id).toMatch(/^[a-z0-9-]+@[a-z0-9.-]+$/);
    expect(gecko.strict_min_version).toBe("140.0");
    expect(gecko.data_collection_permissions).toEqual({ required: ["browsingActivity"] });
  });

  it("keeps the Chrome-family build free of browser_specific_settings", () => {
    expect(readManifest("chrome-mv3")).not.toHaveProperty("browser_specific_settings");
  });
});
