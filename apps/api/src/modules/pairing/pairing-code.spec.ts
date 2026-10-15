import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_CODE_PATTERN,
} from "./pairing-code";

describe("generatePairingCode", () => {
  it("shows XXXX-XXXX-XXXX-XXXX-XXXX in the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const { display } = generatePairingCode();
      expect(display).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(display).not.toMatch(/[ILOU]/);
    }
  });

  it("stores the SHA-256 of the normalized code, never the code", () => {
    const { display, hash } = generatePairingCode();
    const normalized = display.replaceAll("-", "");
    expect(hash).toBe(createHash("sha256").update(normalized).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalized);
  });

  it("does not repeat (100 bits)", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generatePairingCode().display));
    expect(seen.size).toBe(2000);
  });

  it("uses every symbol of the alphabet", () => {
    const symbols = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const char of generatePairingCode().display.replaceAll("-", "")) symbols.add(char);
    }
    expect(symbols.size).toBe(32);
  });
});

describe("normalizePairingCode", () => {
  const { display } = generatePairingCode();
  const plain = display.replaceAll("-", "");

  it("accepts the shown form, without dashes, in lower case, and with stray spaces", () => {
    for (const presented of [
      display,
      plain,
      display.toLowerCase(),
      `  ${display}  `,
      display.replaceAll("-", " "),
    ]) {
      expect(normalizePairingCode(presented)).toBe(plain);
    }
  });

  it("reads the look-alikes the Crockford way", () => {
    expect(normalizePairingCode("OOOO-IIII-LLLL-0000-1111")).toBe("00001111111100001111");
  });

  it.each([
    ["too short", "ABCD-EFGH"],
    ["too long", `${"A".repeat(21)}`],
    ["a symbol outside the alphabet", "UUUU-UUUU-UUUU-UUUU-UUUU"],
    ["punctuation", "AAAA-AAAA-AAAA-AAAA-AAA!"],
    ["empty", ""],
    ["a very long string", "A".repeat(10_000)],
    ["a SQL fragment", "' or 1=1 --"],
    ["not a string", 12345],
    ["undefined", undefined],
    ["null", null],
  ])("rejects %s", (_label, presented) => {
    expect(normalizePairingCode(presented)).toBeNull();
  });

  it("produces only strings that match the pattern", () => {
    expect(PAIRING_CODE_PATTERN.test(plain)).toBe(true);
    expect(hashPairingCode(plain)).toBe(generateHashOf(plain));
  });
});

function generateHashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
