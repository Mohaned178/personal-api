import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M2-00c: the Firefox e2e smoke must run in CI (headless, on ubuntu) as its own job. There is no
// YAML parser in the repo, so this reads the job block as text. The job id is pinned: `e2e-firefox`.

const workflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const FIREFOX_RUN = /playwright\.firefox\.config\.ts|test:e2e:firefox/;

/** The text of `jobs.<id>`: from its 2-space-indented key to the next job (or the end). */
function jobBlock(id: string): string | undefined {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("CI job e2e-firefox", () => {
  const block = jobBlock("e2e-firefox") ?? "";

  it("exists as its own job, separate from the Chromium e2e job", () => {
    expect(jobBlock("e2e-firefox")).toBeDefined();
    expect(jobBlock("e2e")).toBeDefined();
  });

  it("runs on an ubuntu runner and has a timeout", () => {
    expect(block).toMatch(/^ {4}runs-on: ubuntu-/m);
    expect(block).toMatch(/^ {4}timeout-minutes: \d+/m);
  });

  it("is a real gate: it does not continue on error", () => {
    expect(block).not.toBe("");
    expect(block).not.toMatch(/continue-on-error:\s*true/);
  });

  it("checks out, sets up pnpm and node, and installs with the frozen lockfile", () => {
    expect(block).toMatch(/actions\/checkout@/);
    expect(block).toMatch(/pnpm\/action-setup@/);
    expect(block).toMatch(/actions\/setup-node@/);
    expect(block).toContain("pnpm install --frozen-lockfile");
  });

  it("pins every action to a full commit SHA, like the other jobs", () => {
    const uses = block.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40}\b/);
  });

  it("makes sure Firefox is installed (setup action or an explicit version check)", () => {
    expect(block).toMatch(
      /browser-actions\/setup-firefox@|firefox --version|apt-get install[^\n]*firefox/,
    );
  });

  it("builds the extension for Firefox before running the tests", () => {
    const build = block.indexOf("pnpm --filter extension build:firefox");
    const run = block.search(FIREFOX_RUN);
    expect(build).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(build).toBeLessThan(run);
  });

  it("runs the Firefox Playwright config, headless through the harness (no xvfb)", () => {
    expect(block).toMatch(FIREFOX_RUN);
    expect(block).not.toMatch(/xvfb/i);
  });

  it("does not run the Firefox specs from the Chromium e2e job", () => {
    expect(jobBlock("e2e") ?? "").not.toMatch(FIREFOX_RUN);
  });
});
