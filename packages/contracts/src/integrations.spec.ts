import { describe, expect, it } from "vitest";
import {
  createIntegrationRequestSchema,
  createIntegrationResponseSchema,
  integrationSchema,
  renameIntegrationRequestSchema,
} from "./integrations.js";

describe("createIntegrationRequestSchema", () => {
  it("accepts an http integration and trims the name", () => {
    expect(createIntegrationRequestSchema.parse({ kind: "http", name: "  Laptop  " })).toEqual({
      kind: "http",
      name: "Laptop",
    });
  });

  it.each([
    ["unknown key", { kind: "http", name: "a", extra: 1 }],
    ["userId", { kind: "http", name: "a", userId: "u" }],
    ["defaultPolicy", { kind: "http", name: "a", defaultPolicy: "allow" }],
    ["status", { kind: "http", name: "a", status: "revoked" }],
    ["chrome-extension kind", { kind: "chrome-extension", name: "a" }],
    ["missing kind", { name: "a" }],
    ["blank name", { kind: "http", name: "   " }],
    ["long name", { kind: "http", name: "x".repeat(81) }],
    ["non-string name", { kind: "http", name: 5 }],
  ])("rejects %s", (_label, body) => {
    expect(createIntegrationRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("renameIntegrationRequestSchema", () => {
  it("accepts only a name", () => {
    expect(renameIntegrationRequestSchema.parse({ name: "New" })).toEqual({ name: "New" });
    expect(renameIntegrationRequestSchema.safeParse({ name: "New", kind: "http" }).success).toBe(
      false,
    );
    expect(renameIntegrationRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("response schemas", () => {
  const integration = {
    id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
    kind: "http",
    name: "Laptop",
    defaultPolicy: "deny",
    status: "active",
    lastSeenAt: null,
    createdAt: "2026-10-14T12:00:00.000Z",
  };

  it("never allows a key or hash on an integration", () => {
    expect(integrationSchema.safeParse(integration).success).toBe(true);
    expect(integrationSchema.safeParse({ ...integration, hash: "x" }).success).toBe(false);
    expect(integrationSchema.safeParse({ ...integration, key: "pa_ing_x" }).success).toBe(false);
  });

  it("carries the ingest key only in the create response", () => {
    const created = {
      integration,
      ingestKey: { id: integration.id, key: "pa_ing_x", prefix: "pa_ing_x" },
    };
    expect(createIntegrationResponseSchema.safeParse(created).success).toBe(true);
  });
});
