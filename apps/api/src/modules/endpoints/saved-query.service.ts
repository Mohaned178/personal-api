import { Inject, Injectable } from "@nestjs/common";
import {
  SAVED_QUERY_INVALID_CODE,
  SAVED_QUERY_TIMEOUT_CODE,
  type SavedQueryResult,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { SettingsService } from "../settings/settings.service";
import { compileSavedQuery, InvalidSavedQueryError } from "./saved-query.compiler";
import { SavedQueryRepository } from "./saved-query.repository";

/** Postgres `query_canceled`: what `statement_timeout` raises. */
const QUERY_CANCELED = "57014";

/** The pg error may be wrapped by the ORM, which keeps it as `cause`. */
function isStatementTimeout(error: unknown): boolean {
  for (
    let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 3;
    depth++
  ) {
    if (e.code === QUERY_CANCELED) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * Runs a stored saved-query definition for one user: the user's time zone and the clock decide
 * what `today` means, then the compiled query runs read-only under a 2-second timeout. `userId`
 * comes from the AuthContext (the endpoint's owner), never from a request (invariant 4).
 */
@Injectable()
export class SavedQueryService {
  constructor(
    private readonly repository: SavedQueryRepository,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(userId: string, definition: unknown): Promise<SavedQueryResult> {
    assertUserScope(userId);
    const { timeZone } = await this.settings.get(userId);
    let compiled: ReturnType<typeof compileSavedQuery>;
    try {
      compiled = compileSavedQuery(definition, { userId, now: this.clock.now(), timeZone });
    } catch (error) {
      if (error instanceof InvalidSavedQueryError) {
        throw new AppException(409, SAVED_QUERY_INVALID_CODE, "Saved query definition is invalid");
      }
      throw error;
    }
    try {
      return await this.repository.run(userId, compiled);
    } catch (error) {
      if (isStatementTimeout(error)) {
        throw new AppException(504, SAVED_QUERY_TIMEOUT_CODE, "Saved query timed out");
      }
      throw error;
    }
  }
}
