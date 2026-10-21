import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import type { FocusResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { FocusStartDto } from "./focus.dto";
import { FocusService } from "./focus.service";

/**
 * Dashboard routes for the focus session. The user is the session's; the body never names a user
 * or an end time, the server sets both. The guard runs before the validation pipe, so no session
 * is always 401.
 */
@Controller("v1/focus")
@UseGuards(SessionGuard)
export class FocusController {
  constructor(private readonly focus: FocusService) {}

  @Get()
  current(@CurrentAuth("session") auth: SessionAuthContext): Promise<FocusResponse> {
    return this.focus.current(auth.userId);
  }

  /** Starts a session, replacing the running one. */
  @Post()
  start(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: FocusStartDto,
  ): Promise<FocusResponse> {
    return this.focus.start(auth.userId, body);
  }

  /** Ends the running session. 404 `focus.not_found` when there is none. */
  @Delete()
  @HttpCode(204)
  end(@CurrentAuth("session") auth: SessionAuthContext): Promise<void> {
    return this.focus.end(auth.userId);
  }
}
