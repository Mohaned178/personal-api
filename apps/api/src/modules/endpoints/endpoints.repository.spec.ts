/**
 * "No repository method can be called without a user scope" (unit, no DB): every public method
 * takes `userId` first and rejects with MissingUserScopeError before touching the database.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { EndpointsRepository } from "./endpoints.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(EndpointsRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (EndpointsRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("EndpointsRepository tenant scoping", () => {
  it("lists the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods().sort()).toEqual([
      "create",
      "findById",
      "findBySlug",
      "list",
      "remove",
      "replace",
      "rotateKey",
    ]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new EndpointsRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const values = { slug: "s", enabled: true, definition: {} };
    const key = { prefix: "p", hash: "h" };
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        await expect(
          (async () => repo[name]?.(bad, values, key, new Date(), key))(),
          `${name}(${JSON.stringify(bad)})`,
        ).rejects.toBeInstanceOf(MissingUserScopeError);
      }
    }
  });
});
