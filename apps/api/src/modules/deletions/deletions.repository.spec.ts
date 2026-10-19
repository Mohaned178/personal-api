/**
 * "No repository method can be called without a user scope" (unit, no DB), the same convention as
 * the other repositories: every public method takes `userId` first and rejects with
 * MissingUserScopeError before touching the database.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { DeletionsRepository } from "./deletions.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(DeletionsRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (DeletionsRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("DeletionsRepository tenant scoping", () => {
  it("has the methods the services rely on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods().sort()).toEqual([
      "addDeleted",
      "countMatching",
      "create",
      "deleteBatch",
      "findById",
      "finish",
      "markRunning",
      "setTotal",
    ]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new DeletionsRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        await expect(
          (async () => repo[name]?.(bad, {}, 10))(),
          `${name}(${JSON.stringify(bad)})`,
        ).rejects.toBeInstanceOf(MissingUserScopeError);
      }
    }
  });
});
