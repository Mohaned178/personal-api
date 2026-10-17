/**
 * "No repository method can be called without a user scope" (unit, no DB), the same convention as
 * the other repositories.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { DiagnosticsRepository } from "./diagnostics.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(DiagnosticsRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (DiagnosticsRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("DiagnosticsRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods().sort()).toEqual(["ingestionSince", "listIntegrations"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new DiagnosticsRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        await expect(
          (async () => repo[name]?.(bad, new Date()))(),
          `${name}(${JSON.stringify(bad)})`,
        ).rejects.toBeInstanceOf(MissingUserScopeError);
      }
    }
  });
});
