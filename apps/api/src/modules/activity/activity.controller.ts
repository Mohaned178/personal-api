import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { ActivityDailyResponse, ActivityDomainsResponse } from "@personal-api/contracts";
import { CurrentReader, type ReaderAuthContext } from "../auth/auth-context";
import { RequireReadScope } from "../keys/read-key.guard";
import { SessionOrReadKeyGuard } from "../keys/session-or-read-key.guard";
import { ActivityDailyQueryDto, ActivityDomainsQueryDto } from "./activity.dto";
import { type ActivityAccess, ActivityService } from "./activity.service";

/** Aggregates for a session or a read key with `activity:read`. The user is the caller's, never the query's. */
@Controller("v1/activity")
@UseGuards(SessionOrReadKeyGuard)
@RequireReadScope("activity:read")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get("daily")
  daily(
    @CurrentReader() auth: ReaderAuthContext,
    @Query() query: ActivityDailyQueryDto,
  ): Promise<ActivityDailyResponse> {
    return this.activity.daily(auth.userId, query, access(auth));
  }

  @Get("domains")
  domains(
    @CurrentReader() auth: ReaderAuthContext,
    @Query() query: ActivityDomainsQueryDto,
  ): Promise<ActivityDomainsResponse> {
    return this.activity.domains(auth.userId, query, access(auth));
  }
}

function access(auth: ReaderAuthContext): ActivityAccess {
  return { restriction: auth.kind === "read" ? auth.restriction : null };
}
