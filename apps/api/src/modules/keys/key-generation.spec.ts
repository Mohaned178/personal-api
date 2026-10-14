/**
 * M1-03 key generation (unit, no DB). Pins: `pa_ing_` / `pa_read_` + base64url (no padding) of
 * 32 random bytes; a short display prefix; and a lowercase-hex SHA-256 of the full key.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./key-generation";

const INGEST = /^pa_ing_[A-Za-z0-9_-]{43}$/;
const READ = /^pa_read_[A-Za-z0-9_-]{43}$/;

describe("generateApiKey", () => {
  it("makes ingest keys as pa_ing_ + 43 base64url chars (32 bytes, no padding)", () => {
    expect(generateApiKey("ingest").plaintext).toMatch(INGEST);
  });

  it("makes read keys as pa_read_ + 43 base64url chars", () => {
    expect(generateApiKey("read").plaintext).toMatch(READ);
  });

  it("encodes exactly 32 random bytes after the marker", () => {
    for (const [kind, marker] of [
      ["ingest", "pa_ing_"],
      ["read", "pa_read_"],
    ] as const) {
      const body = generateApiKey(kind).plaintext.slice(marker.length);
      expect(Buffer.from(body, "base64url")).toHaveLength(32);
      expect(Buffer.from(body, "base64url").toString("base64url")).toBe(body);
    }
  });

  it("hashes the full plaintext with SHA-256 as 64 lowercase hex chars", () => {
    const key = generateApiKey("ingest");
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).toBe(createHash("sha256").update(key.plaintext).digest("hex"));
  });

  it("never puts the plaintext or its secret part inside the hash or the prefix", () => {
    const key = generateApiKey("read");
    const secret = key.plaintext.slice("pa_read_".length);
    expect(key.hash).not.toContain(secret);
    expect(key.prefix).not.toBe(key.plaintext);
    expect(key.prefix.length).toBeLessThan(key.plaintext.length / 2);
  });

  it("gives a short display prefix that is the start of the key and names its kind", () => {
    const ingest = generateApiKey("ingest");
    const read = generateApiKey("read");
    expect(ingest.plaintext.startsWith(ingest.prefix)).toBe(true);
    expect(read.plaintext.startsWith(read.prefix)).toBe(true);
    expect(ingest.prefix.startsWith("pa_ing_")).toBe(true);
    expect(read.prefix.startsWith("pa_read_")).toBe(true);
    // Long enough to tell keys apart, short enough not to leak the secret.
    for (const key of [ingest, read]) {
      expect(key.prefix.length).toBeGreaterThan(key === ingest ? 7 : 8);
      expect(key.prefix.length).toBeLessThanOrEqual(16);
    }
  });

  it("generates 500 distinct keys with distinct hashes and no repeated body", () => {
    const keys = Array.from({ length: 500 }, () => generateApiKey("ingest"));
    expect(new Set(keys.map((k) => k.plaintext)).size).toBe(500);
    expect(new Set(keys.map((k) => k.hash)).size).toBe(500);
  });

  it("uses all of the base64url alphabet over many keys (not a narrow or fixed charset)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const ch of generateApiKey("ingest").plaintext.slice("pa_ing_".length)) seen.add(ch);
    }
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });

  it("rejects an unknown kind instead of guessing", () => {
    // Control: the real kinds work, so a throw below is a deliberate refusal.
    expect(generateApiKey("ingest").plaintext).toMatch(INGEST);
    expect(() => generateApiKey("admin" as never)).toThrow();
    expect(() => generateApiKey(undefined as never)).toThrow();
  });
});

describe("hashApiKey", () => {
  it("is the lowercase hex SHA-256 of its input, and deterministic", () => {
    const key = generateApiKey("ingest").plaintext;
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("matches the hash returned at generation time, so lookup by hash finds the key", () => {
    const key = generateApiKey("read");
    expect(hashApiKey(key.plaintext)).toBe(key.hash);
  });

  it("changes completely when one character of the key changes", () => {
    const key = generateApiKey("ingest").plaintext;
    const flipped = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
    expect(hashApiKey(flipped)).not.toBe(hashApiKey(key));
  });

  it("hashes any string without throwing (empty, unicode, very long)", () => {
    for (const input of ["", "pa_ing_", "ключ-🔑", "x".repeat(100_000), "\u0000"]) {
      expect(hashApiKey(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});
