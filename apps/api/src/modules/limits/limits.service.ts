import { Inject, Injectable } from "@nestjs/common";
import {
  LIMIT_LIMIT_REACHED_CODE,
  LIMIT_NOT_FOUND_CODE,
  LIMIT_PATTERN_TAKEN_CODE,
  LIMITS_PER_USER_MAX,
  type Limit,
  type LimitListResponse,
  type LimitSave,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { type LimitChangeResult, LimitsRepository } from "./limits.repository";

/**
 * Daily site limits for one user. `userId` always comes from the session AuthContext. An unknown
 * id, someone else's id and a malformed id all give the same 404, so the API never confirms that
 * another user's limit exists. The body was validated by the request DTO (the contracts' schema).
 * Nothing here logs: a pattern is a domain.
 */
@Injectable()
export class LimitsService {
  constructor(
    private readonly repository: LimitsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<LimitListResponse> {
    assertUserScope(userId);
    return { limits: await this.repository.list(userId) };
  }

  async create(userId: string, save: LimitSave): Promise<Limit> {
    assertUserScope(userId);
    return changed(await this.repository.create(userId, save, this.clock.now()));
  }

  async replace(userId: string, id: string, save: LimitSave): Promise<Limit> {
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
  return new AppException(404, LIMIT_NOT_FOUND_CODE, "Limit not found");
}

function changed(result: LimitChangeResult): Limit {
  if (result === "not_found") throw notFound();
  if (result === "pattern_taken") {
    throw new AppException(
      409,
      LIMIT_PATTERN_TAKEN_CODE,
      "Pattern already has a limit",
      "Change the existing limit for that pattern instead",
    );
  }
  if (result === "limit_reached") {
    throw new AppException(
      409,
      LIMIT_LIMIT_REACHED_CODE,
      "Limit count reached",
      `A user can have at most ${LIMITS_PER_USER_MAX} limits`,
    );
  }
  return result;
}
