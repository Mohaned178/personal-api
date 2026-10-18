import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// PLAN §3 principle 2 and CLAUDE.md: `packages/rules` stays pure, so the extension and the server
// give identical results. This reads the shipped sources as text. The build (`types: []`, no DOM
// lib) also refuses Node and DOM globals.

const dir = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(dir)
  .filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && name !== "test-helpers.ts",
  )
  .map((name) => ({ name, text: readFileSync(`${dir}${name}`, "utf8") }));

const ALLOWED_IMPORTS = new Set(["@personal-api/contracts"]);
const FORBIDDEN_GLOBALS =
  /\b(process\.|Buffer\b|require\(|window\b|document\b|chrome\.|browser\.|fetch\(|setTimeout\(|setInterval\(|Date\.now\(|new Date\(\)|Math\.random\(|console\.|crypto\.|performance\.)/;

describe("packages/rules stays pure", () => {
  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThanOrEqual(4);
  });

  it("imports only relative files and @personal-api/contracts", () => {
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        const target = match[1] ?? "";
        expect(
          target.startsWith("./") || ALLOWED_IMPORTS.has(target),
          `${name} imports ${target}`,
        ).toBe(true);
      }
    }
  });

  it("uses no clock, randomness, I/O or platform globals", () => {
    for (const { name, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(FORBIDDEN_GLOBALS);
    }
  });

  it("does not use regular expressions on rule data (invariant 8: no regex ops)", () => {
    for (const { name, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/new RegExp|\.match\(|\.test\(|\.replace\(\//);
    }
  });
});
