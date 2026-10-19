import { describe, expect, it } from "vitest";
import { toContractIssues } from "./errors.js";
import {
  createReadKeyRequestSchema,
  createReadKeyResponseSchema,
  endpointScope,
  readKeyRestrictionSchema,
  readKeySchema,
  readScopeSchema,
} from "./read-keys.js";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const OTHER_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c";

describe("createReadKeyRequestSchema", () => {
  it("accepts scopes alone", () => {
    expect(createReadKeyRequestSchema.parse({ scopes: ["events:read"] })).toEqual({
      scopes: ["events:read"],
    });
  });

  it("accepts a trimmed name, both scopes and a restriction", () => {
    const body = {
      name: "  Dashboard widget  ",
      scopes: ["events:read", "activity:read"],
      restriction: { sources: [ID], types: ["browser.*", "browser.page_visited"] },
    };
    expect(createReadKeyRequestSchema.parse(body)).toEqual({ ...body, name: "Dashboard widget" });
  });

  it.each([
    ["no scopes at all", {}],
    ["an empty scope list", { scopes: [] }],
    ["an unknown scope", { scopes: ["events:write"] }],
    ["an endpoint scope (minted by M5-05, not here)", { scopes: [endpointScope(ID)] }],
    ["a scope that is not a string", { scopes: [1] }],
    ["scopes as a string", { scopes: "events:read" }],
    ["a duplicated scope", { scopes: ["events:read", "events:read"] }],
    ["userId", { scopes: ["events:read"], userId: "u" }],
    ["integrationId", { scopes: ["events:read"], integrationId: ID }],
    ["kind", { scopes: ["events:read"], kind: "ingest" }],
    ["a unknown key", { scopes: ["events:read"], extra: 1 }],
    ["a blank name", { scopes: ["events:read"], name: "   " }],
    ["a long name", { scopes: ["events:read"], name: "x".repeat(81) }],
    ["a non-string name", { scopes: ["events:read"], name: 5 }],
    ["an unknown restriction key", { scopes: ["events:read"], restriction: { userId: "u" } }],
    ["a null restriction", { scopes: ["events:read"], restriction: null }],
  ])("rejects %s", (_label, body) => {
    expect(createReadKeyRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("readKeyRestrictionSchema", () => {
  it("accepts sources only, types only, or both", () => {
    expect(readKeyRestrictionSchema.safeParse({ sources: [ID] }).success).toBe(true);
    expect(readKeyRestrictionSchema.safeParse({ types: ["browser.*"] }).success).toBe(true);
    expect(readKeyRestrictionSchema.safeParse({ sources: [ID], types: ["a.b"] }).success).toBe(
      true,
    );
  });

  it.each([
    ["an empty object (no restriction is null, not {})", {}],
    ["an empty source list", { sources: [] }],
    ["an empty type list", { types: [] }],
    ["a source that is not a uuid", { sources: ["github.com"] }],
    ["a source kind instead of an integration id", { sources: ["browser-extension"] }],
    ["too many sources", { sources: Array.from({ length: 21 }, () => ID) }],
    ["too many types", { types: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ["an empty type", { types: [""] }],
    ["an uppercase type", { types: ["Browser.*"] }],
    ["a type with a LIKE wildcard", { types: ["browser.%"] }],
    ["a type with a single-character wildcard", { types: ["browser.?"] }],
    ["a regex type", { types: ["browser\\..*"] }],
    ["a type with a space", { types: ["browser page"] }],
    ["a type that is too long", { types: ["a".repeat(65)] }],
    ["a type with more than 8 wildcards", { types: ["*a*a*a*a*a*a*a*a*"] }],
    ["an unknown key", { sources: [ID], integrationId: ID }],
  ])("rejects %s", (_label, body) => {
    expect(readKeyRestrictionSchema.safeParse(body).success).toBe(false);
  });
});

describe("readScopeSchema (what a stored key may carry)", () => {
  it("accepts the two fixed scopes and an endpoint scope with a uuid", () => {
    for (const scope of ["events:read", "activity:read", endpointScope(ID)]) {
      expect(readScopeSchema.safeParse(scope).success, scope).toBe(true);
    }
  });

  it.each([
    "endpoint:",
    "endpoint:*",
    "endpoint:not-a-uuid",
    `endpoint:${ID} `,
    `endpoint:${ID.toUpperCase()}`,
    "events:*",
    "*",
    "",
    "events:write",
  ])("rejects %j", (scope) => {
    expect(readScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("builds endpoint scopes from an id", () => {
    expect(endpointScope(ID)).toBe(`endpoint:${ID}`);
    expect(endpointScope(ID)).not.toBe(endpointScope(OTHER_ID));
  });
});

describe("read key responses", () => {
  const readKey = {
    id: ID,
    name: null,
    prefix: "pa_read_abcdef",
    scopes: ["events:read"],
    restriction: null,
    createdAt: "2026-10-19T10:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };

  it("describes a key without its secret or hash", () => {
    expect(readKeySchema.parse(readKey)).toEqual(readKey);
    expect(readKeySchema.safeParse({ ...readKey, hash: "h" }).success).toBe(false);
    expect(readKeySchema.safeParse({ ...readKey, key: "pa_read_x" }).success).toBe(false);
    expect(readKeySchema.safeParse({ ...readKey, userId: "u" }).success).toBe(false);
  });

  it("returns the plaintext only in the create response", () => {
    const created = { readKey, key: "pa_read_secret" };
    expect(createReadKeyResponseSchema.parse(created)).toEqual(created);
    expect(createReadKeyResponseSchema.safeParse({ readKey }).success).toBe(false);
  });
});

describe("error messages", () => {
  it("never echo a rejected type pattern", () => {
    const result = createReadKeyRequestSchema.safeParse({
      scopes: ["events:read"],
      restriction: { types: ["SECRET-pattern-7c1e"] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(toContractIssues(result.error.issues))).not.toContain(
      "SECRET-pattern-7c1e",
    );
  });
});
