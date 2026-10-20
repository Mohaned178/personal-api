import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_VERSION } from "../lib/heartbeat";
import wxtConfig from "../wxt.config";

// M7-R fixes: release packaging that lives outside any one package. Like ci-firefox-e2e.spec.ts,
// this reads the repo files as text, because no YAML or ignore-file parser is in the repo.

const fromRoot = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const readText = (path: string) => readFileSync(fromRoot(path), "utf8").replace(/\r\n/g, "\n");
const readJson = (path: string) => JSON.parse(readText(path)) as Record<string, unknown>;

describe("S1: source zip and Docker context leave out data and env files at any depth", () => {
  const excluded = (wxtConfig.zip?.excludeSources ?? []) as string[];

  it("excludes data folders and .env files anywhere in the Firefox sources zip", () => {
    // `data/**` alone is root-only: apps/api/data/exports leaked into the zip in a repro.
    expect(excluded).toContain("**/data/**");
    expect(excluded).toContain("**/.env*");
  });

  it("keeps the .dockerignore equivalents, but still ships .env.example", () => {
    const lines = readText(".dockerignore")
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain("**/data");
    expect(lines).toContain("**/.env*");
    expect(lines).toContain("!**/.env.example");
  });
});

describe("S3: production compose trusts one proxy by default, and can be overridden", () => {
  const compose = readText("docker-compose.prod.yml");

  it("reads TRUST_PROXY from the environment with a default of 1 (Caddy)", () => {
    expect(compose).toMatch(/^ {2}TRUST_PROXY: \$\{TRUST_PROXY:-1\}$/m);
    expect(compose).not.toMatch(/^ {2}TRUST_PROXY: "1"$/m);
  });

  it("says a directly published API needs 0", () => {
    const before = compose.slice(0, compose.indexOf("TRUST_PROXY:"));
    expect(before.split("\n").slice(-4).join("\n")).toMatch(
      /directly[^\n]*\b0\b|\b0\b[^\n]*directly/,
    );
  });
});

describe("N2: the heartbeat's CLIENT_VERSION is the extension version", () => {
  it("matches apps/extension/package.json", () => {
    expect(CLIENT_VERSION).toBe(readJson("apps/extension/package.json").version);
  });

  it("matches the version in both built manifests", () => {
    for (const target of ["chrome-mv3", "firefox-mv3"]) {
      const manifest = readJson(`apps/extension/.output/${target}/manifest.json`);
      expect(manifest.version).toBe(CLIENT_VERSION);
    }
  });
});

describe("License: AGPL-3.0-only", () => {
  const workspaces = [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "apps/extension/package.json",
    "apps/e2e/package.json",
    "packages/contracts/package.json",
    "packages/rules/package.json",
    "packages/tsconfig/package.json",
  ];

  it("has a LICENSE file with the AGPL-3.0 text", () => {
    expect(existsSync(fromRoot("LICENSE"))).toBe(true);
    const text = readText("LICENSE");
    expect(text).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(text).toContain("Version 3, 19 November 2007");
  });

  it.each(workspaces)("%s declares the license", (path) => {
    expect(readJson(path).license).toBe("AGPL-3.0-only");
  });
});
