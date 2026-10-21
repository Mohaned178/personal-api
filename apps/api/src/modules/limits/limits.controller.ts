import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import type { Limit, LimitListResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { LimitSaveDto } from "./limits.dto";
import { LimitsService } from "./limits.service";

/**
 * Dashboard routes for daily site limits. The user is the session's; the body never names a user,
 * and the server sets the limit id. The guard runs before the validation pipe, so no session is
 * always 401.
 */
@Controller("v1/limits")
@UseGuards(SessionGuard)
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<LimitListResponse> {
    return this.limits.list(auth.userId);
  }

  @Post()
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: LimitSaveDto,
  ): Promise<Limit> {
    return this.limits.create(auth.userId, body);
  }

  /** Replaces the whole limit. */
  @Put(":id")
  replace(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: LimitSaveDto,
  ): Promise<Limit> {
    return this.limits.replace(auth.userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentAuth("session") auth: SessionAuthContext, @Param("id") id: string): Promise<void> {
    return this.limits.remove(auth.userId, id);
  }
}
