import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ACCOUNT_PASSWORD_INVALID_CODE,
  ACCOUNT_RATE_LIMITED_CODE,
  type DeleteAccountRequest,
} from "@personal-api/contracts";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import type { Auth } from "../auth/auth";
import { AUTH } from "../auth/auth.tokens";
import type { SessionAuthContext } from "../auth/auth-context";
import { ACCOUNT_RATE_LIMITER } from "./account.constants";
import { AccountRepository } from "./account.repository";
import { AccountDeletionSteps } from "./account.steps";

/** Throttled: the controller sets `Retry-After` from `retryAfterSeconds`. */
export class AccountRateLimitedError extends AppException {
  constructor(readonly retryAfterSeconds: number) {
    super(429, ACCOUNT_RATE_LIMITED_CODE, "Too many attempts to delete this account");
  }
}

/** A session cookie to expire: Better Auth's own name and attributes, so a `__Secure-` prefix is right. */
export interface CookieToClear {
  name: string;
  options: { path: string; httpOnly: boolean; secure: boolean; sameSite: "lax" };
}

/**
 * Deletes the signed-in user's account. The account is the session's; nothing in the request
 * selects it. The password is checked here, against Better Auth's own hash, because a stolen
 * session cookie alone must not be enough to destroy everything.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly repository: AccountRepository,
    private readonly steps: AccountDeletionSteps,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ACCOUNT_RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async delete(auth: SessionAuthContext, request: DeleteAccountRequest): Promise<void> {
    const { userId } = auth;
    assertUserScope(userId);
    // Every attempt counts, before the password is looked at, so a throttled caller learns nothing.
    const attempt = this.limiter.consume(userId);
    if (!attempt.allowed) throw new AccountRateLimitedError(Math.ceil(attempt.retryAfterMs / 1000));

    await this.assertPassword(userId, request.password);
    // Steps first (files on disk): they need the rows that say what exists, and if one throws the
    // request can simply be repeated because nothing was deleted yet.
    for (const step of this.steps.list()) {
      try {
        await step.run(userId);
      } catch (error) {
        // Name only: an error message can carry paths or user data (invariant 6).
        this.logger.error(
          `account deletion step "${step.name}" failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
        throw error;
      }
    }
    await this.repository.deleteAccount(userId, auth.user.email);
    this.logger.log("account deleted");
  }

  /** The cookies a browser holds for this session, to expire once the account is gone. */
  async sessionCookies(): Promise<CookieToClear[]> {
    const { authCookies } = await this.auth.$context;
    return [
      authCookies.sessionToken,
      authCookies.sessionData,
      authCookies.dontRememberToken,
      authCookies.accountData,
    ].map(({ name, attributes }) => ({
      name,
      options: {
        path: attributes.path ?? "/",
        httpOnly: true,
        secure: attributes.secure === true,
        sameSite: "lax",
      },
    }));
  }

  /** The same 403 whether the password is wrong or the account has none to check. */
  private async assertPassword(userId: string, password: string): Promise<void> {
    const hash = await this.repository.findPasswordHash(userId);
    const context = await this.auth.$context;
    const valid = hash === null ? false : await context.password.verify({ hash, password });
    if (!valid) {
      throw new AppException(403, ACCOUNT_PASSWORD_INVALID_CODE, "The password is not correct");
    }
  }
}
