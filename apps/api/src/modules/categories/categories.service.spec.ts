import {
  CATEGORY_LIMIT_REACHED_CODE,
  CATEGORY_NOT_FOUND_CODE,
  CATEGORY_PATTERN_TAKEN_CODE,
  PRESET_CATEGORY_DOMAINS,
} from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { CategoriesRepository } from "./categories.repository";
import { CategoriesService } from "./categories.service";

const USER = "user-1";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const save = { pattern: "youtube.com", category: "productive" as const };
const rule = { id: ID, ...save };

function setup(result: unknown = "not_found") {
  const repository = {
    list: vi.fn(async () => [rule]),
    create: vi.fn(async () => result),
    replace: vi.fn(async () => result),
    remove: vi.fn(async () => result === rule),
  };
  const service = new CategoriesService(
    repository as unknown as CategoriesRepository,
    new FakeClock(NOW),
  );
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

describe("CategoriesService", () => {
  it.each(["not-a-uuid", "", "1", "../../etc"])(
    "a malformed id (%j) is a 404 category.not_found without a query",
    async (id) => {
      const { repository, service } = setup();
      for (const call of [service.replace(USER, id, save), service.remove(USER, id)]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe(CATEGORY_NOT_FOUND_CODE);
      }
      expect(repository.replace).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it("lists the overrides with the built-in list", async () => {
    const { service } = setup();
    const listed = await service.list(USER);
    expect(listed.rules).toEqual([rule]);
    expect(listed.presets.distracting).toEqual([...PRESET_CATEGORY_DOMAINS.distracting]);
    expect(listed.presets.productive).toEqual([...PRESET_CATEGORY_DOMAINS.productive]);
  });

  it("maps a refusal to its problem+json code", async () => {
    expect((await problem(setup("pattern_taken").service.create(USER, save))).code).toBe(
      CATEGORY_PATTERN_TAKEN_CODE,
    );
    expect((await problem(setup("limit_reached").service.create(USER, save))).code).toBe(
      CATEGORY_LIMIT_REACHED_CODE,
    );
    expect((await problem(setup("not_found").service.replace(USER, ID, save))).code).toBe(
      CATEGORY_NOT_FOUND_CODE,
    );
  });

  it("returns what the repository stored and stamps the clock", async () => {
    const { repository, service } = setup(rule);
    expect(await service.create(USER, save)).toEqual(rule);
    expect(repository.create).toHaveBeenCalledWith(USER, save, NOW);
  });

  it("rejects a missing user before touching the repository", async () => {
    const { repository, service } = setup();
    for (const bad of [undefined, null, "", "  "]) {
      const user = bad as unknown as string;
      await expect(service.list(user)).rejects.toBeInstanceOf(MissingUserScopeError);
      await expect(service.rules(user)).rejects.toBeInstanceOf(MissingUserScopeError);
      await expect(service.create(user, save)).rejects.toBeInstanceOf(MissingUserScopeError);
    }
    expect(repository.list).not.toHaveBeenCalled();
  });
});
