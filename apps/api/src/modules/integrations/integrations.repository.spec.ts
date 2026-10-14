/**
 * M1-04 "no repository method can be called without a user scope" (unit, no DB), the same
 * convention as ApiKeysRepository: every public method takes `userId` first and rejects with
 * MissingUserScopeError before touching the database. There is no unscoped exception here.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { IntegrationsRepository } from "./integrations.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(IntegrationsRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (IntegrationsRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("IntegrationsRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods().sort()).toEqual(["createHttp", "findById", "list", "rename", "revoke"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new IntegrationsRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        const call = async () =>
          repo[name]?.(bad, { name: "x" }, { prefix: "p", hash: "h" }, new Date());
        await expect(call(), `${name}(${JSON.stringify(bad)})`).rejects.toBeInstanceOf(
          MissingUserScopeError,
        );
      }
    }
  });
});
