import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_MS,
  pairingCodeResponseSchema,
  pairRequestSchema,
  pairResponseSchema,
} from "./pairing.js";

describe("pairRequestSchema", () => {
  it("accepts only a pairing code", () => {
    expect(pairRequestSchema.parse({ pairingCode: "ABCD-EFGH" })).toEqual({
      pairingCode: "ABCD-EFGH",
    });
  });

  it.each([
    ["no code", {}],
    ["empty code", { pairingCode: "" }],
    ["very long code", { pairingCode: "A".repeat(65) }],
    ["non-string code", { pairingCode: 12345 }],
    ["userId", { pairingCode: "ABCD", userId: "u" }],
    [
      "integrationId",
      { pairingCode: "ABCD", integrationId: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b" },
    ],
  ])("rejects %s", (_label, body) => {
    expect(pairRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("response schemas", () => {
  const integration = {
    id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
    kind: "browser-extension",
    name: "Work Edge",
    defaultPolicy: "deny",
    status: "active",
    lastSeenAt: null,
    createdAt: "2026-10-14T12:00:00.000Z",
  };

  it("carries the ingest key only in the pair response", () => {
    const paired = {
      integration,
      ingestKey: { id: integration.id, key: "pa_ing_x", prefix: "pa_ing_x" },
    };
    expect(pairResponseSchema.safeParse(paired).success).toBe(true);
    expect(pairResponseSchema.safeParse({ ...paired, userId: "u" }).success).toBe(false);
    expect(pairResponseSchema.safeParse({ integration }).success).toBe(false);
  });

  it("returns a code with its expiry and nothing else", () => {
    const issued = { pairingCode: "ABCD", expiresAt: "2026-10-14T12:10:00.000Z" };
    expect(pairingCodeResponseSchema.safeParse(issued).success).toBe(true);
    expect(pairingCodeResponseSchema.safeParse({ ...issued, codeHash: "x" }).success).toBe(false);
  });

  it("keeps the code valid for 10 minutes", () => {
    expect(PAIRING_CODE_TTL_MS).toBe(600_000);
  });
});
