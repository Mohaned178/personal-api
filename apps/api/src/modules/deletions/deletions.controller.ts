import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import type { DeletionResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { DeletionsService } from "./deletions.service";

/** Progress of a bulk deletion. The user is the session's; the id alone never selects a tenant. */
@Controller("v1/events/deletions")
@UseGuards(SessionGuard)
export class DeletionsController {
  constructor(private readonly deletions: DeletionsService) {}

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<DeletionResponse> {
    return this.deletions.get(auth.userId, id);
  }
}
