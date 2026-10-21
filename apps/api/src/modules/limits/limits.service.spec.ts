import { LIMIT_NOT_FOUND_CODE, LIMIT_PATTERN_TAKEN_CODE } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { LimitsRepository } from "./limits.repository";
import { LimitsService } from "./limits.service";

const USER = "user-1";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const save = { pattern: "youtube.com", minutes: 30, strict: false };
const limit = { id: ID, ...save };

function setup(result: unknown = "not_found") {
  const repository = {
    list: vi.fn(async () => [limit]),
    create: vi.fn(async () => result),
    replace: vi.fn(async () => result),
    remove: vi.fn(async () => result === limit),
  };
  const service = new LimitsService(repository as unknown as LimitsRepository, new FakeClock(NOW));
  return { repository, service };
}

async function problem(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe("LimitsService", () => {
  it.each(["not-a-uuid", "", "1", "../../etc"])(
    "a malformed id (%j) is a 404 limit.not_found without a query",
    async (id) => {
      const { repository, service } = setup();
      for (const call of [service.replace(USER, id, save), service.remove(USER, id)]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe(LIMIT_NOT_FOUND_CODE);
      }
      expect(repository.replace).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it("lists the user's limits", async () => {
    const { service } = setup();
    expect(await service.list(USER)).toEqual({ limits: [limit] });
  });

  it("creates and replaces with the clock's time", async () => {
    const { repository, service } = setup(limit);
    expect(await service.create(USER, save)).toEqual(limit);
    expect(repository.create).toHaveBeenCalledWith(USER, save, NOW);
    expect(await service.replace(USER, ID, save)).toEqual(limit);
    expect(repository.replace).toHaveBeenCalledWith(USER, ID, save, NOW);
  });

  it("answers 404 for an id that is not the user's (replace and remove)", async () => {
    const { service } = setup("not_found");
    for (const call of [service.replace(USER, ID, save), service.remove(USER, ID)]) {
      const error = await problem(call);
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe(LIMIT_NOT_FOUND_CODE);
    }
  });

  it("answers 409 limit.pattern_taken when the pattern already has a limit", async () => {
    const { service } = setup("pattern_taken");
    for (const call of [service.create(USER, save), service.replace(USER, ID, save)]) {
      const error = await problem(call);
      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(LIMIT_PATTERN_TAKEN_CODE);
    }
  });

  it("answers 409 limit.limit_reached when the user has the most limits allowed", async () => {
    const { service } = setup("limit_reached");
    const error = await problem(service.create(USER, save));
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe("limit.limit_reached");
  });

  it("never puts the pattern in an error", async () => {
    const { service } = setup("pattern_taken");
    const error = await problem(service.create(USER, save));
    expect(JSON.stringify([error.message, error.detail, error.extensions])).not.toContain(
      "youtube",
    );
  });

  it("rejects a missing user before any query", async () => {
    const { repository, service } = setup();
    await expect(service.list("")).rejects.toBeInstanceOf(MissingUserScopeError);
    await expect(service.create("  ", save)).rejects.toBeInstanceOf(MissingUserScopeError);
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });
});
