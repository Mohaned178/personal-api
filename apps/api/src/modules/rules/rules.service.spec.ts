import type { RuleDefinition } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { RulesRepository } from "./rules.repository";
import { RulesService } from "./rules.service";

const USER = "user-1";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const definition = {
  name: "x",
  enabled: true,
  priority: 1,
  stage: "collect",
  when: {},
  then: [{ action: "allow" }],
} as RuleDefinition;

function setup(result: unknown = "not_found") {
  const repository = {
    list: vi.fn(async () => ({ version: 0, rules: [] })),
    findById: vi.fn(async () => null),
    create: vi.fn(async () => result),
    replace: vi.fn(async () => result),
    remove: vi.fn(async () => result),
  };
  const service = new RulesService(repository as unknown as RulesRepository, new FakeClock(NOW));
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

describe("RulesService", () => {
  it.each(["not-a-uuid", "", "1", "../../etc"])(
    "a malformed id (%j) is a 404 rule.not_found without a query",
    async (id) => {
      const { repository, service } = setup();
      for (const call of [
        service.get(USER, id),
        service.replace(USER, id, definition),
        service.remove(USER, id),
      ]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe("rule.not_found");
      }
      expect(repository.findById).not.toHaveBeenCalled();
      expect(repository.replace).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it("maps a full rule set to 409 rule.limit_reached", async () => {
    const { service } = setup("limit_reached");
    const error = await problem(service.create(USER, definition));
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe("rule.limit_reached");
  });

  it("passes the clock's time to the repository", async () => {
    const { repository, service } = setup({ rule: { id: "x" }, version: 1 });
    await service.create(USER, definition);
    expect(repository.create).toHaveBeenCalledWith(USER, definition, NOW);
  });

  it.each([undefined, null, "", "  "])(
    "rejects a missing user (%j) before any query",
    async (bad) => {
      const { repository, service } = setup();
      const user = bad as unknown as string;
      await expect(service.list(user)).rejects.toBeInstanceOf(MissingUserScopeError);
      await expect(service.create(user, definition)).rejects.toBeInstanceOf(MissingUserScopeError);
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    },
  );
});
