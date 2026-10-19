import { Inject, Injectable } from "@nestjs/common";
import {
  SAVED_QUERY_INVALID_CODE,
  SAVED_QUERY_TIMEOUT_CODE,
  type SavedQueryResult,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { hasPgErrorCode, PG_QUERY_CANCELED } from "../../platform/db/pg-error";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { SettingsService } from "../settings/settings.service";
import { withSavedTimeZone } from "../settings/time-zone.errors";
import { compileSavedQuery, InvalidSavedQueryError } from "./saved-query.compiler";
import { SavedQueryRepository } from "./saved-query.repository";

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
      return await withSavedTimeZone(() => this.repository.run(userId, compiled));
    } catch (error) {
      if (hasPgErrorCode(error, PG_QUERY_CANCELED)) {
        throw new AppException(504, SAVED_QUERY_TIMEOUT_CODE, "Saved query timed out");
      }
      throw error;
    }
  }
}
