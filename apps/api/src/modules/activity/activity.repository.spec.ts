/**
 * "No repository method can be called without a user scope" (unit, no DB): every public method
 * takes `userId` first and rejects with MissingUserScopeError before touching the database.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { ActivityRepository } from "./activity.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(ActivityRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (ActivityRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("ActivityRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods().sort()).toEqual(["daily", "domains", "hours", "sessions", "site"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new ActivityRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const filters = { from: new Date(0), to: new Date(1) };
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        await expect(
          (async () => repo[name]?.(bad, filters, 10))(),
          `${name}(${JSON.stringify(bad)})`,
        ).rejects.toBeInstanceOf(MissingUserScopeError);
      }
    }
  });
});
