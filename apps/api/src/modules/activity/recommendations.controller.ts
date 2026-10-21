import { Controller, Get, UseGuards } from "@nestjs/common";
import type { RecommendationsResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { RecommendationsService } from "./recommendations.service";

/** Suggestions for the signed-in user. The user is the session's; there is no query. */
@Controller("v1/recommendations")
@UseGuards(SessionGuard)
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  get(@CurrentAuth("session") auth: SessionAuthContext): Promise<RecommendationsResponse> {
    return this.recommendations.get(auth.userId);
  }
}
