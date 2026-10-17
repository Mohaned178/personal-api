import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { DiagnosticsResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { DiagnosticsQueryDto } from "./diagnostics.dto";
import { DiagnosticsService } from "./diagnostics.service";

/** Dashboard health view. The user is the session's; the query never names a user. */
@Controller("v1/diagnostics")
@UseGuards(SessionGuard)
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: DiagnosticsQueryDto,
  ): Promise<DiagnosticsResponse> {
    return this.diagnostics.get(auth.userId, query);
  }
}
