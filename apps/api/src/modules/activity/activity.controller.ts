import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type {
  ActivityCategoriesResponse,
  ActivityDailyResponse,
  ActivityDomainsResponse,
  ActivityHoursResponse,
  ActivitySessionsResponse,
  ActivitySiteResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import {
  ActivityCategoriesQueryDto,
  ActivityDailyQueryDto,
  ActivityDomainsQueryDto,
  ActivityHoursQueryDto,
  ActivitySessionsQueryDto,
  ActivitySiteQueryDto,
} from "./activity.dto";
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

  @Get("categories")
  categories(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivityCategoriesQueryDto,
  ): Promise<ActivityCategoriesResponse> {
    return this.activity.categories(auth.userId, query);
  }

  @Get("site")
  site(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivitySiteQueryDto,
  ): Promise<ActivitySiteResponse> {
    return this.activity.site(auth.userId, query);
  }

  @Get("hours")
  hours(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivityHoursQueryDto,
  ): Promise<ActivityHoursResponse> {
    return this.activity.hours(auth.userId, query);
  }

  @Get("sessions")
  sessions(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ActivitySessionsQueryDto,
  ): Promise<ActivitySessionsResponse> {
    return this.activity.sessions(auth.userId, query);
  }
}
