import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from "@nestjs/common";
import type { RetentionPolicy, RetentionResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { PutRetentionDto } from "./retention.dto";
import { RetentionService } from "./retention.service";

/** Dashboard routes for retention policies. The user is the session's, never the body's or the path's. */
@Controller("v1/retention")
@UseGuards(SessionGuard)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<RetentionResponse> {
    return this.retention.list(auth.userId);
  }

  @Put(":scope/:target")
  put(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("scope") scope: string,
    @Param("target") target: string,
    @Body() body: PutRetentionDto,
  ): Promise<RetentionPolicy> {
    return this.retention.put(auth.userId, scope, target, body.days);
  }

  @Delete(":scope/:target")
  @HttpCode(204)
  remove(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("scope") scope: string,
    @Param("target") target: string,
  ): Promise<void> {
    return this.retention.remove(auth.userId, scope, target);
  }
}
