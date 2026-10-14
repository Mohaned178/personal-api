/**
 * M1-03 "no repository method can be called without a user scope" (unit, no DB).
 *
 * Convention enforced for ApiKeysRepository: every public method takes `userId` as its first
 * argument and rejects with MissingUserScopeError before touching the database. The one
 * documented exception is `findByHash`, the pre-auth lookup that finds out who the caller is.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { ApiKeysRepository } from "./api-keys.repository";

const UNSCOPED_ALLOWLIST = new Set(["constructor", "findByHash"]);

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(ApiKeysRepository.prototype).filter(
    (name) =>
      typeof (ApiKeysRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" && !name.startsWith("_"),
  );
}

describe("ApiKeysRepository tenant scoping", () => {
  it("rejects every scoped method with MissingUserScopeError when userId is missing", async () => {
    const repo = new ApiKeysRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const scoped = publicMethods().filter((name) => !UNSCOPED_ALLOWLIST.has(name));
    expect(scoped.length).toBeGreaterThan(0);
    for (const name of scoped) {
      for (const bad of [undefined, null, "", "   "]) {
        const call = async () => repo[name]?.(bad, "id-1", new Date(), {});
        await expect(call(), `${name}(${JSON.stringify(bad)})`).rejects.toBeInstanceOf(
          MissingUserScopeError,
        );
      }
    }
  });
});
