import { SCHEDULE_LIMIT_REACHED_CODE, SCHEDULE_NOT_FOUND_CODE } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { SchedulesRepository } from "./schedules.repository";
import { SchedulesService } from "./schedules.service";

const USER = "user-1";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const save = {
  name: "Work",
  patterns: ["x.com"],
  days: [0, 1],
  start: "09:00",
  end: "17:00",
  enabled: true,
};
const schedule = { id: ID, ...save };

function setup(result: unknown = "not_found") {
  const repository = {
    list: vi.fn(async () => [schedule]),
    create: vi.fn(async () => result),
    replace: vi.fn(async () => result),
    remove: vi.fn(async () => result === schedule),
  };
  const service = new SchedulesService(
    repository as unknown as SchedulesRepository,
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

describe("SchedulesService", () => {
  it.each(["not-a-uuid", "", "1", "../../etc"])(
    "a malformed id (%j) is a 404 schedule.not_found without a query",
    async (id) => {
      const { repository, service } = setup();
      for (const call of [service.replace(USER, id, save), service.remove(USER, id)]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe(SCHEDULE_NOT_FOUND_CODE);
      }
      expect(repository.replace).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it("lists all schedules, and only the enabled ones for the config", async () => {
    const { repository, service } = setup();
    expect(await service.list(USER)).toEqual({ schedules: [schedule] });
    expect(await service.listEnabled(USER)).toEqual([schedule]);
    expect(repository.list).toHaveBeenNthCalledWith(1, USER);
    expect(repository.list).toHaveBeenNthCalledWith(2, USER, true);
  });

  it("creates and replaces with the server clock", async () => {
    const { repository, service } = setup(schedule);
    expect(await service.create(USER, save)).toEqual(schedule);
    expect(await service.replace(USER, ID, save)).toEqual(schedule);
    expect(repository.create).toHaveBeenCalledWith(USER, save, NOW);
    expect(repository.replace).toHaveBeenCalledWith(USER, ID, save, NOW);
  });

  it("maps a refused create to 409 schedule.limit_reached", async () => {
    const { service } = setup("limit_reached");
    const error = await problem(service.create(USER, save));
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(SCHEDULE_LIMIT_REACHED_CODE);
  });

  it("maps a replace that found nothing to 404, and a remove that removed nothing", async () => {
    const { service } = setup("not_found");
    expect((await problem(service.replace(USER, ID, save))).getStatus()).toBe(404);
    expect((await problem(service.remove(USER, ID))).getStatus()).toBe(404);
  });

  it("refuses a missing user before the repository is used", async () => {
    const { repository, service } = setup();
    for (const call of [
      service.list(""),
      service.listEnabled(" "),
      service.create("", save),
      service.replace("", ID, save),
      service.remove("", ID),
    ]) {
      await expect(call).rejects.toBeInstanceOf(MissingUserScopeError);
    }
    expect(repository.list).not.toHaveBeenCalled();
  });
});
