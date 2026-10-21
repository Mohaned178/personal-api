/**
 * "No repository method can be called without a user scope" (unit, no DB), the same convention as
 * the other repositories: every public method takes `userId` first and rejects before touching the
 * database.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { SchedulesRepository } from "./schedules.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const AT = new Date("2026-10-21T12:00:00.000Z");
const SAVE = {
  name: "Work",
  patterns: ["x.com"],
  days: [0],
  start: "09:00",
  end: "17:00",
  enabled: true,
};

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(SchedulesRepository.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (SchedulesRepository.prototype as unknown as Record<string, unknown>)[name] ===
        "function" &&
      !name.startsWith("_"),
  );
}

describe("SchedulesRepository tenant scoping", () => {
  it("has the methods the service relies on (so the scoping check below is not vacuous)", () => {
    expect(publicMethods()).toEqual(["list", "create", "replace", "remove"]);
  });

  it("rejects every method with MissingUserScopeError when userId is missing", async () => {
    const repo = new SchedulesRepository(untouchedDb) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const args: Record<string, unknown[]> = {
      list: [],
      create: [SAVE, AT],
      replace: [ID, SAVE, AT],
      remove: [ID],
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
