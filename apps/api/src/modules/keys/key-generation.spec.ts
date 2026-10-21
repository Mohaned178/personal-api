/**
 * M1-03 key generation (unit, no DB). Pins: `pa_ing_` + base64url (no padding) of 32 random
 * bytes; a short display prefix; and a lowercase-hex SHA-256 of the full key. Read keys were
 * removed in M9-01, so the ingest key is the only kind.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, INGEST_KEY_PATTERN } from "./key-generation";

const INGEST = /^pa_ing_[A-Za-z0-9_-]{43}$/;

describe("generateApiKey", () => {
  it("makes keys as pa_ing_ + 43 base64url chars (32 bytes, no padding)", () => {
    expect(generateApiKey().plaintext).toMatch(INGEST);
  });

  it("encodes exactly 32 random bytes after the marker", () => {
    const body = generateApiKey().plaintext.slice("pa_ing_".length);
    expect(Buffer.from(body, "base64url")).toHaveLength(32);
    expect(Buffer.from(body, "base64url").toString("base64url")).toBe(body);
  });

  it("hashes the full plaintext with SHA-256 as 64 lowercase hex chars", () => {
    const key = generateApiKey();
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).toBe(createHash("sha256").update(key.plaintext).digest("hex"));
  });

  it("never puts the plaintext or its secret part inside the hash or the prefix", () => {
    const key = generateApiKey();
    const secret = key.plaintext.slice("pa_ing_".length);
    expect(key.hash).not.toContain(secret);
    expect(key.prefix).not.toBe(key.plaintext);
    expect(key.prefix.length).toBeLessThan(key.plaintext.length / 2);
  });

  it("gives a short display prefix that is the start of the key and names its kind", () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
    expect(key.prefix.startsWith("pa_ing_")).toBe(true);
    // Long enough to tell keys apart, short enough not to leak the secret.
    expect(key.prefix.length).toBeGreaterThan(7);
    expect(key.prefix.length).toBeLessThanOrEqual(16);
  });

  it("generates 500 distinct keys with distinct hashes and no repeated body", () => {
    const keys = Array.from({ length: 500 }, () => generateApiKey());
    expect(new Set(keys.map((k) => k.plaintext)).size).toBe(500);
    expect(new Set(keys.map((k) => k.hash)).size).toBe(500);
  });

  it("uses all of the base64url alphabet over many keys (not a narrow or fixed charset)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const ch of generateApiKey().plaintext.slice("pa_ing_".length)) seen.add(ch);
    }
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });
});

describe("hashApiKey", () => {
  it("is the lowercase hex SHA-256 of its input, and deterministic", () => {
    const key = generateApiKey().plaintext;
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("matches the hash returned at generation time, so lookup by hash finds the key", () => {
    const key = generateApiKey();
    expect(hashApiKey(key.plaintext)).toBe(key.hash);
  });

  it("changes completely when one character of the key changes", () => {
    const key = generateApiKey().plaintext;
    const flipped = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
    expect(hashApiKey(flipped)).not.toBe(hashApiKey(key));
  });

  it("hashes any string without throwing (empty, unicode, very long)", () => {
    for (const input of ["", "pa_ing_", "ключ-🔑", "x".repeat(100_000), "\u0000"]) {
      expect(hashApiKey(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});

describe("key pattern", () => {
  it("accepts an ingest key and refuses a pa_read_ key of the same shape", () => {
    expect(INGEST_KEY_PATTERN.test(generateApiKey().plaintext)).toBe(true);
    expect(INGEST_KEY_PATTERN.test(`pa_read_${"A".repeat(43)}`)).toBe(false);
  });

  it("refuses a truncated, padded or suffixed key", () => {
    const key = generateApiKey().plaintext;
    for (const bad of [key.slice(0, -1), `${key}A`, `${key}\n`, ` ${key}`, "pa_ing_"]) {
      expect(INGEST_KEY_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
