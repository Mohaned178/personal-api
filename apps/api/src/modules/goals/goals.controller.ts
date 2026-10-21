import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from "@nestjs/common";
import type { Goal, GoalListResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { GoalSaveDto } from "./goals.dto";
import { GoalsService } from "./goals.service";

/**
 * Dashboard routes for daily goals. The user is the session's; the path names a category, never a
 * user. The guard runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/goals")
@UseGuards(SessionGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<GoalListResponse> {
    return this.goals.list(auth.userId);
  }

  /** Sets (or replaces) the goal of a category. */
  @Put(":category")
  put(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("category") category: string,
    @Body() body: GoalSaveDto,
  ): Promise<Goal> {
    return this.goals.put(auth.userId, category, body);
  }

  @Delete(":category")
  @HttpCode(204)
  remove(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("category") category: string,
  ): Promise<void> {
    return this.goals.remove(auth.userId, category);
  }
}
