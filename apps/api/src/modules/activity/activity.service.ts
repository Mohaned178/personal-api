import { Inject, Injectable } from "@nestjs/common";
import {
  ACTIVITY_DEFAULT_DAYS,
  ACTIVITY_DOMAINS_DEFAULT_LIMIT,
  ACTIVITY_MAX_DAYS,
  ACTIVITY_RANGE_INVALID_CODE,
  type ActivityDailyQuery,
  type ActivityDailyResponse,
  type ActivityDomainsQuery,
  type ActivityDomainsResponse,
  type ReadKeyRestriction,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { SettingsService } from "../settings/settings.service";
import { withSavedTimeZone } from "../settings/time-zone.errors";
import { ActivityRepository } from "./activity.repository";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a caller got in: a read key's restriction narrows what is counted. */
export interface ActivityAccess {
  restriction: ReadKeyRestriction | null;
}

@Injectable()
export class ActivityService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async daily(
    userId: string,
    query: ActivityDailyQuery,
    access: ActivityAccess,
  ): Promise<ActivityDailyResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const { timeZone } = await this.settings.get(userId);
    const days = await withSavedTimeZone(() =>
      this.repository.daily(userId, filters(from, to, access), timeZone),
    );
    return { from: from.toISOString(), to: to.toISOString(), timeZone, days };
  }

  async domains(
    userId: string,
    query: ActivityDomainsQuery,
    access: ActivityAccess,
  ): Promise<ActivityDomainsResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const domains = await this.repository.domains(
      userId,
      filters(from, to, access),
      query.limit ?? ACTIVITY_DOMAINS_DEFAULT_LIMIT,
    );
    return { from: from.toISOString(), to: to.toISOString(), domains };
  }

  /** `to` defaults to now and `from` to a week before `to`; the pair must be a non-empty range of at most 90 days. */
  private resolveRange(query: { from?: string | undefined; to?: string | undefined }) {
    const to = query.to ? new Date(query.to) : this.clock.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - ACTIVITY_DEFAULT_DAYS * DAY_MS);
    const span = to.getTime() - from.getTime();
    if (span <= 0 || span > ACTIVITY_MAX_DAYS * DAY_MS) {
      throw new AppException(
        400,
        ACTIVITY_RANGE_INVALID_CODE,
        "Invalid time range",
        `from must be before to, at most ${ACTIVITY_MAX_DAYS} days apart`,
      );
    }
    return { from, to };
  }
}

function filters(from: Date, to: Date, access: ActivityAccess) {
  return { from, to, sources: access.restriction?.sources, types: access.restriction?.types };
}
