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
import type { Schedule, ScheduleListResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { ScheduleSaveDto } from "./schedules.dto";
import { SchedulesService } from "./schedules.service";

/**
 * Dashboard routes for block schedules. The user is the session's; the body never names a user,
 * and the server sets the schedule id. The guard runs before the validation pipe, so no session is
 * always 401.
 */
@Controller("v1/schedules")
@UseGuards(SessionGuard)
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<ScheduleListResponse> {
    return this.schedules.list(auth.userId);
  }

  @Post()
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: ScheduleSaveDto,
  ): Promise<Schedule> {
    return this.schedules.create(auth.userId, body);
  }

  /** Replaces the whole schedule. */
  @Put(":id")
  replace(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: ScheduleSaveDto,
  ): Promise<Schedule> {
    return this.schedules.replace(auth.userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentAuth("session") auth: SessionAuthContext, @Param("id") id: string): Promise<void> {
    return this.schedules.remove(auth.userId, id);
  }
}
