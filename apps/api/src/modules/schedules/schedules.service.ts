import { Inject, Injectable } from "@nestjs/common";
import {
  SCHEDULE_LIMIT_REACHED_CODE,
  SCHEDULE_NOT_FOUND_CODE,
  SCHEDULES_PER_USER_MAX,
  type Schedule,
  type ScheduleListResponse,
  type ScheduleSave,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { type ScheduleChangeResult, SchedulesRepository } from "./schedules.repository";

/**
 * Block schedules for one user. `userId` always comes from the session AuthContext. An unknown id,
 * someone else's id and a malformed id all give the same 404, so the API never confirms that
 * another user's schedule exists. The body was validated by the request DTO (the contracts'
 * schema). Nothing here logs: names and patterns are the user's own text.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly repository: SchedulesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<ScheduleListResponse> {
    assertUserScope(userId);
    return { schedules: await this.repository.list(userId) };
  }

  /** The enabled schedules, for the extension config. */
  async listEnabled(userId: string): Promise<Schedule[]> {
    assertUserScope(userId);
    return this.repository.list(userId, true);
  }

  async create(userId: string, save: ScheduleSave): Promise<Schedule> {
    assertUserScope(userId);
    return changed(await this.repository.create(userId, save, this.clock.now()));
  }

  async replace(userId: string, id: string, save: ScheduleSave): Promise<Schedule> {
    assertUserScope(userId);
    if (!isUuid(id)) throw notFound();
    return changed(await this.repository.replace(userId, id, save, this.clock.now()));
  }

  async remove(userId: string, id: string): Promise<void> {
    assertUserScope(userId);
    if (!isUuid(id) || !(await this.repository.remove(userId, id))) throw notFound();
  }
}

function notFound(): AppException {
  return new AppException(404, SCHEDULE_NOT_FOUND_CODE, "Schedule not found");
}

function changed(result: ScheduleChangeResult): Schedule {
  if (result === "not_found") throw notFound();
  if (result === "limit_reached") {
    throw new AppException(
      409,
      SCHEDULE_LIMIT_REACHED_CODE,
      "Schedule count reached",
      `A user can have at most ${SCHEDULES_PER_USER_MAX} schedules`,
    );
  }
  return result;
}
