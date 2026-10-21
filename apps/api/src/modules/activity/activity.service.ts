import { Inject, Injectable } from "@nestjs/common";
import {
  ACTIVITY_CURSOR_INVALID_CODE,
  ACTIVITY_DEFAULT_DAYS,
  ACTIVITY_DOMAINS_DEFAULT_LIMIT,
  ACTIVITY_MAX_DAYS,
  ACTIVITY_RANGE_INVALID_CODE,
  ACTIVITY_SESSIONS_DEFAULT_LIMIT,
  ACTIVITY_SITE_PATHS_LIMIT,
  type ActivityDailyQuery,
  type ActivityDailyResponse,
  type ActivityDomainsQuery,
  type ActivityDomainsResponse,
  type ActivityHoursQuery,
  type ActivityHoursResponse,
  type ActivitySessionsQuery,
  type ActivitySessionsResponse,
  type ActivitySiteQuery,
  type ActivitySiteResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { decodeCursor, encodeCursor } from "../events/events.cursor";
import { SettingsService } from "../settings/settings.service";
import { withSavedTimeZone } from "../settings/time-zone.errors";
import { ActivityRepository } from "./activity.repository";

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActivityService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async daily(userId: string, query: ActivityDailyQuery): Promise<ActivityDailyResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const { timeZone } = await this.settings.get(userId);
    const days = await withSavedTimeZone(() =>
      this.repository.daily(userId, { from, to }, timeZone),
    );
    return { from: from.toISOString(), to: to.toISOString(), timeZone, days };
  }

  async domains(userId: string, query: ActivityDomainsQuery): Promise<ActivityDomainsResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const domains = await this.repository.domains(
      userId,
      { from, to },
      query.limit ?? ACTIVITY_DOMAINS_DEFAULT_LIMIT,
    );
    return { from: from.toISOString(), to: to.toISOString(), domains };
  }

  async site(userId: string, query: ActivitySiteQuery): Promise<ActivitySiteResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const { timeZone } = await this.settings.get(userId);
    const rows = await withSavedTimeZone(() =>
      this.repository.site(userId, query.domain, { from, to }, timeZone, ACTIVITY_SITE_PATHS_LIMIT),
    );
    return {
      domain: query.domain,
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone,
      days: rows.days,
      activeMs: rows.activeMs,
      pageVisits: rows.pageVisits,
      sessions: rows.sessions,
      averageSessionMs: rows.sessions === 0 ? 0 : Math.round(rows.activeMs / rows.sessions),
      longestSessionMs: rows.longestSessionMs,
      paths: rows.paths,
    };
  }

  async hours(userId: string, query: ActivityHoursQuery): Promise<ActivityHoursResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const { timeZone } = await this.settings.get(userId);
    const cells = await withSavedTimeZone(() =>
      this.repository.hours(userId, { from, to }, timeZone),
    );
    return { from: from.toISOString(), to: to.toISOString(), timeZone, cells };
  }

  async sessions(userId: string, query: ActivitySessionsQuery): Promise<ActivitySessionsResponse> {
    assertUserScope(userId);
    const { from, to } = this.resolveRange(query);
    const limit = query.limit ?? ACTIVITY_SESSIONS_DEFAULT_LIMIT;
    const after = query.cursor
      ? decodeCursor(query.cursor, ACTIVITY_CURSOR_INVALID_CODE)
      : undefined;
    const rows = await this.repository.sessions(userId, { from, to, after }, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      sessions: page.map((r) => ({
        id: r.id,
        domain: r.domain,
        startedAt: new Date(r.occurredAt.getTime() - r.durationMs).toISOString(),
        endedAt: r.occurredAt.toISOString(),
        durationMs: r.durationMs,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
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
