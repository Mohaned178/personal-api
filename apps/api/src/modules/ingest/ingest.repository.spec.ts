/**
 * M1-05 "no repository method can be called without a user scope" (unit, no DB), the same
 * convention as the other repositories: every public method takes `userId` first and rejects
 * before touching the database. The ingest write also needs the integration from the AuthContext.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError, TenantScopeViolationError } from "../../platform/db/tenant-scope";
import { IngestRepository } from "./ingest.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

const INTEGRATION = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const KEY = "0192f1c2-7c1e-7a3b-9f00-2d3e4f5a6b7c";
const batch = { events: [], bucket: new Date("2026-10-14T12:00:00.000Z") };
const summarize = () => ({ accepted: 0, duplicate: 0, dropped: 0, rejected: 0, byReason: {} });

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(IngestRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (IngestRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("IngestRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods()).toEqual([
      "loadCaller",
      "storeBatch",
      "touchLastSeen",
      "recordHeartbeat",
    ]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new IngestRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of publicMethods()) {
      for (const bad of [undefined, null, "", "   "]) {
        const call = async () => repo[name]?.(bad, INTEGRATION, batch, summarize);
        await expect(call(), `${name}(${JSON.stringify(bad)})`).rejects.toBeInstanceOf(
          MissingUserScopeError,
        );
      }
    }
  });

  it.each([undefined, null, "", "not-a-uuid"])(
    "refuses to store without an integration id from the auth context (%j)",
    async (bad) => {
      const repo = new IngestRepository(untouchedDb);
      await expect(
        repo.storeBatch("user-1", bad as unknown as string, KEY, batch, summarize),
      ).rejects.toBeInstanceOf(TenantScopeViolationError);
    },
  );

  it.each([undefined, null, "", "not-a-uuid"])(
    "refuses to store without a key id from the auth context (%j)",
    async (bad) => {
      const repo = new IngestRepository(untouchedDb);
      await expect(
        repo.storeBatch("user-1", INTEGRATION, bad as unknown as string, batch, summarize),
      ).rejects.toBeInstanceOf(TenantScopeViolationError);
    },
  );
});
