import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import type { Settings } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { UpdateSettingsDto } from "./settings.dto";
import { SettingsService } from "./settings.service";

/** The signed-in user's own settings. Dashboard only; the user is the session's, never the body's. */
@Controller("v1/settings")
@UseGuards(SessionGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@CurrentAuth("session") auth: SessionAuthContext): Promise<Settings> {
    return this.settings.get(auth.userId);
  }

  @Patch()
  update(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: UpdateSettingsDto,
  ): Promise<Settings> {
    return this.settings.update(auth.userId, body);
  }
}
