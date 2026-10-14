/**
 * M1-03 tenant-scoped repository helper (unit, no DB): it cannot be created, so cannot run a
 * query, without a userId. Behavior against a real database is in tenant-scope.int.spec.ts.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "./db";
import { MissingUserScopeError, tenantScope } from "./tenant-scope";

/** A database that fails the test if anything touches it. */
const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

describe("tenantScope without a user scope", () => {
  it("throws MissingUserScopeError for an empty userId", () => {
    expect(() => tenantScope(untouchedDb, "")).toThrow(MissingUserScopeError);
  });

  it("throws MissingUserScopeError for a blank (whitespace) userId", () => {
    expect(() => tenantScope(untouchedDb, "   ")).toThrow(MissingUserScopeError);
  });

  it("throws MissingUserScopeError for undefined and null userId", () => {
    expect(() => tenantScope(untouchedDb, undefined as never)).toThrow(MissingUserScopeError);
    expect(() => tenantScope(untouchedDb, null as never)).toThrow(MissingUserScopeError);
  });

  it("throws MissingUserScopeError for a non-string userId (number, object, array)", () => {
    for (const bad of [0, 42, {}, { id: "u" }, ["u"], true]) {
      expect(() => tenantScope(untouchedDb, bad as never)).toThrow(MissingUserScopeError);
    }
  });

  it("cannot be called with the userId argument omitted (compile error and runtime refusal)", () => {
    // @ts-expect-error the userId parameter is required
    expect(() => tenantScope(untouchedDb)).toThrow(MissingUserScopeError);
  });

  it("exposes the scope's userId and the four query methods once created", () => {
    // Creating a scope does not query; only running a method does.
    const scope = tenantScope(untouchedDb, "user-1");
    expect(scope.userId).toBe("user-1");
    for (const method of ["select", "insert", "update", "delete"] as const) {
      expect(typeof scope[method]).toBe("function");
    }
  });

  it("refuses a table that has no user_id column, before touching the database", async () => {
    const scope = tenantScope(untouchedDb, "user-1");
    const notTenantOwned = { id: "x" } as never;
    const error = await Promise.resolve()
      .then(() => scope.select(notTenantOwned))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    // Refused by the helper itself, not by the proxy catching a query attempt.
    expect((error as Error).message).not.toMatch(/database touched/);
  });
});
