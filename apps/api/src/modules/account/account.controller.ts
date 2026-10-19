import { Body, Controller, Delete, Header, HttpCode, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { DeleteAccountDto } from "./account.dto";
import { AccountRateLimitedError, AccountService } from "./account.service";

/**
 * The signed-in user's own account. Dashboard session only (no key can reach it), and the
 * account is the session's, never the body's. The guard runs before the validation pipe, so no
 * session is always 401, whatever the body.
 */
@Controller("v1/account")
@UseGuards(SessionGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /**
   * Deletes the account and everything it owns. Needs the current password and the confirmation
   * phrase. Answers 204 and expires the session cookies; 403 `account.password_invalid` for a wrong
   * password; 429 `account.rate_limited` (with `Retry-After`) after too many attempts.
   */
  @Delete()
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async delete(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    try {
      await this.account.delete(auth, body);
    } catch (error) {
      if (error instanceof AccountRateLimitedError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
    for (const { name, options } of await this.account.sessionCookies()) {
      res.clearCookie(name, options);
    }
  }
}
