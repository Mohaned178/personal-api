import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { ActivityDailyResponse, ActivityDomainsResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { ActivityDailyQueryDto, ActivityDomainsQueryDto } from "./activity.dto";
import { ActivityService } from "./activity.service";

/** Aggregates for the signed-in user. The user is the session's, never the query's. */
@Controller("v1/activity")
@UseGuards(SessionGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get("daily")
  daily(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivityDailyQueryDto,
  ): Promise<ActivityDailyResponse> {
    return this.activity.daily(auth.userId, query);
  }

  @Get("domains")
  domains(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivityDomainsQueryDto,
  ): Promise<ActivityDomainsResponse> {
    return this.activity.domains(auth.userId, query);
  }
}
