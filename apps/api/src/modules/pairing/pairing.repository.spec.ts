/**
 * "No repository method can be called without a user scope" (unit, no DB), the same convention as
 * ApiKeysRepository. The one documented exception is `redeem`: the caller of `POST /v1/pair` has no
 * session, so it finds the owner from the code's own row and scopes everything after that.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { PairingRepository } from "./pairing.repository";

const UNSCOPED_ALLOWLIST = new Set(["redeem"]);

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(PairingRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (PairingRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("PairingRepository tenant scoping", () => {
  it("has exactly the methods the service relies on (so the checks below are not vacuous)", () => {
    expect(publicMethods().sort()).toEqual(["issue", "redeem"]);
  });

  it("rejects every scoped method with MissingUserScopeError when userId is missing", async () => {
    const repo = new PairingRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const scoped = publicMethods().filter((name) => !UNSCOPED_ALLOWLIST.has(name));
    expect(scoped.length).toBeGreaterThan(0);
    for (const name of scoped) {
      for (const bad of [undefined, null, "", "   "]) {
        const call = async () =>
          repo[name]?.(bad, "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b", {
            codeHash: "h",
            expiresAt: new Date(),
          });
        await expect(call(), `${name}(${JSON.stringify(bad)})`).rejects.toBeInstanceOf(
          MissingUserScopeError,
        );
      }
    }
  });
});
