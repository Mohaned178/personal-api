/**
 * The purge repository is the one place that touches events of every user at once (a cron job has
 * no AuthContext), so it is pinned here: it exposes exactly one method, whose inputs are a clock
 * reading and a batch size. Adding a method (for example one that takes a `userId` from outside,
 * or a filter) fails this spec and forces a review. Nothing else in the codebase scans
 * repositories for a missing user scope; the per-repository specs do.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "../../platform/db/db";
import { RetentionPurgeRepository } from "./retention-purge.repository";

const untouchedDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched via ${String(property)}`);
    },
  },
) as unknown as Database;

describe("RetentionPurgeRepository", () => {
  it("exposes exactly one method, purgeExpired(now, limit)", () => {
    const methods = Object.getOwnPropertyNames(RetentionPurgeRepository.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["purgeExpired"]);
    expect(RetentionPurgeRepository.prototype.purgeExpired.length).toBe(2);
  });

  it("refuses a batch size that is not a positive integer before touching the database", async () => {
    const repo = new RetentionPurgeRepository(untouchedDb);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.purgeExpired(new Date(), bad), String(bad)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });
});
