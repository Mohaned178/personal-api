import { Body, Controller, Header, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import type { PairingCodeResponse, PairResponse } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { PairRateLimitGuard } from "./pair-rate-limit.guard";
import { PairDto } from "./pairing.dto";
import { PairingService } from "./pairing.service";

/**
 * Both responses carry a secret shown once (a code, a key), so neither may be cached.
 */
@Controller("v1")
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  /** Dashboard: issue a 10-minute code for one of the session user's extension integrations. */
  @Post("integrations/:id/pairing-code")
  @UseGuards(SessionGuard)
  @Header("Cache-Control", "no-store")
  issueCode(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<PairingCodeResponse> {
    return this.pairing.issueCode(auth.userId, id);
  }

  /**
   * Extension: exchange a code for an ingest key. No credential: the code is the credential, and
   * the throttle runs first. The body names nothing but the code; the user and the integration
   * come from the code's row.
   */
  @Post("pair")
  @HttpCode(200)
  @UseGuards(PairRateLimitGuard)
  @Header("Cache-Control", "no-store")
  pair(@Body() body: PairDto): Promise<PairResponse> {
    return this.pairing.redeem(body.pairingCode);
  }
}
