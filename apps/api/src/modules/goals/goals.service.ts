import { Inject, Injectable } from "@nestjs/common";
import {
  GOAL_NOT_FOUND_CODE,
  type Goal,
  type GoalCategory,
  type GoalListResponse,
  type GoalSave,
  goalCategorySchema,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { GoalsRepository } from "./goals.repository";

/**
 * Daily goals for one user. `userId` always comes from the session AuthContext. A category that is
 * not one a goal can have is the same 404 as a goal that does not exist.
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly repository: GoalsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<GoalListResponse> {
    assertUserScope(userId);
    return { goals: await this.repository.list(userId) };
  }

  async put(userId: string, category: string, save: GoalSave): Promise<Goal> {
    assertUserScope(userId);
    return this.repository.put(userId, goalCategory(category), save.minutes, this.clock.now());
  }

  async remove(userId: string, category: string): Promise<void> {
    assertUserScope(userId);
    if (!(await this.repository.remove(userId, goalCategory(category)))) throw notFound();
  }
}

function goalCategory(value: string): GoalCategory {
  const parsed = goalCategorySchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function notFound(): AppException {
  return new AppException(404, GOAL_NOT_FOUND_CODE, "Goal not found");
}
