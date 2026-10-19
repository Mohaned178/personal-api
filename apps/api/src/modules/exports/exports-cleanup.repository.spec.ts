/**
 * The cleanup repository touches exports of every user at once (a cron job has no AuthContext), so
 * it is pinned here: adding a method, or one that takes a `userId` or a filter from outside, fails
 * this spec and forces a review.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { ExportsCleanupRepository } from "./exports-cleanup.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

describe("ExportsCleanupRepository", () => {
  it("exposes exactly findDue, deleteByIds and existing", () => {
    const methods = Object.getOwnPropertyNames(ExportsCleanupRepository.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(methods).toEqual(["deleteByIds", "existing", "findDue"]);
  });

  it("refuses a batch size that is not a positive integer before touching the database", async () => {
    const repo = new ExportsCleanupRepository(untouchedDb);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(repo.findDue(new Date(), new Date(), bad), String(bad)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it("does nothing, without touching the database, for no ids", async () => {
    const repo = new ExportsCleanupRepository(untouchedDb);
    await repo.deleteByIds([]);
    expect(await repo.existing([])).toEqual([]);
  });
});
