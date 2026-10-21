/**
 * "No repository method can be called without a user scope" (unit, no DB), the same convention as
 * the other repositories: every public method takes `userId` first and rejects before touching the
 * database.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { GoalsRepository } from "./goals.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

const AT = new Date("2026-10-21T12:00:00.000Z");

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(GoalsRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (GoalsRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("GoalsRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods()).toEqual(["list", "put", "remove"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new GoalsRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const args: Record<string, unknown[]> = {
      list: [],
      put: ["distracting", 60, AT],
      remove: ["distracting"],
    };
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        const call = async () => repo[name]?.(bad, ...(args[name] ?? []));
        await expect(call(), `${name}(${JSON.stringify(bad)})`).rejects.toBeInstanceOf(
          MissingUserScopeError,
        );
      }
    }
  });
});
