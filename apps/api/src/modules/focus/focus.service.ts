import { Inject, Injectable } from "@nestjs/common";
import {
  FOCUS_NOT_FOUND_CODE,
  type FocusResponse,
  type FocusSession,
  type FocusStart,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { FocusRepository } from "./focus.repository";

const MINUTE_MS = 60_000;

/**
 * The focus session of one user. `userId` always comes from the session AuthContext, and the end
 * time is the server's clock plus the requested minutes, never a client value. Nothing here logs:
 * patterns are domains.
 */
@Injectable()
export class FocusService {
  constructor(
    private readonly repository: FocusRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The running session, or null (also once it has ended). Used by the extension config. */
  async running(userId: string): Promise<FocusSession | null> {
    assertUserScope(userId);
    return this.repository.current(userId, this.clock.now());
  }

  async current(userId: string): Promise<FocusResponse> {
    return { session: await this.running(userId) };
  }

  async start(userId: string, start: FocusStart): Promise<FocusResponse> {
    assertUserScope(userId);
    const now = this.clock.now();
    const endsAt = new Date(now.getTime() + start.minutes * MINUTE_MS);
    return { session: await this.repository.start(userId, start.patterns, endsAt, now) };
  }

  /** Ends the session. With none to end it is a 404, like any change to something that is not there. */
  async end(userId: string): Promise<void> {
    assertUserScope(userId);
    if (!(await this.repository.end(userId))) {
      throw new AppException(404, FOCUS_NOT_FOUND_CODE, "No focus session to end");
    }
  }
}
