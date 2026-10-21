import { GOAL_NOT_FOUND_CODE } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { GoalsRepository } from "./goals.repository";
import { GoalsService } from "./goals.service";

const USER = "user-1";
const NOW = new Date("2026-10-21T12:00:00.000Z");

function setup(removed = true) {
  const repository = {
    list: vi.fn(async () => []),
    put: vi.fn(async (_u: string, category: string, minutes: number) => ({ category, minutes })),
    remove: vi.fn(async () => removed),
  };
  const service = new GoalsService(repository as unknown as GoalsRepository, new FakeClock(NOW));
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

describe("GoalsService", () => {
  it.each(["productive", "", "DISTRACTING", "../x", "evil"])(
    "a category a goal cannot have (%j) is a 404 goal.not_found without a query",
    async (category) => {
      const { repository, service } = setup();
      for (const call of [
        service.put(USER, category, { minutes: 5 }),
        service.remove(USER, category),
      ]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe(GOAL_NOT_FOUND_CODE);
      }
      expect(repository.put).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it("sets a goal for a category a goal can have", async () => {
    const { repository, service } = setup();
    expect(await service.put(USER, "distracting", { minutes: 60 })).toEqual({
      category: "distracting",
      minutes: 60,
    });
    expect(repository.put).toHaveBeenCalledWith(USER, "distracting", 60, NOW);
  });

  it("removing a goal that is not set is a 404", async () => {
    const { service } = setup(false);
    expect((await problem(service.remove(USER, "neutral"))).code).toBe(GOAL_NOT_FOUND_CODE);
  });

  it("rejects a missing user before touching the repository", async () => {
    const { repository, service } = setup();
    for (const bad of [undefined, null, "", "  "]) {
      const user = bad as unknown as string;
      await expect(service.list(user)).rejects.toBeInstanceOf(MissingUserScopeError);
      await expect(service.put(user, "neutral", { minutes: 5 })).rejects.toBeInstanceOf(
        MissingUserScopeError,
      );
      await expect(service.remove(user, "neutral")).rejects.toBeInstanceOf(MissingUserScopeError);
    }
    expect(repository.list).not.toHaveBeenCalled();
  });
});
