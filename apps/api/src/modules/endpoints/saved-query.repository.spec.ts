/**
 * "No repository method can be called without a user scope" (unit, no DB): every public method
 * takes `userId` first and rejects with MissingUserScopeError before touching the database.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { SavedQueryRepository } from "./saved-query.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(SavedQueryRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (SavedQueryRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("SavedQueryRepository tenant scoping", () => {
  it("has the method the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods()).toEqual(["run"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new SavedQueryRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const query = { kind: "events", where: sql`true`, fields: ["type"], limit: 1 };
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        await expect(
          (async () => repo[name]?.(bad, query))(),
          `${name}(${JSON.stringify(bad)})`,
        ).rejects.toBeInstanceOf(MissingUserScopeError);
      }
    }
  });
});
