import { Inject, Injectable } from "@nestjs/common";
import { RECOMMENDATIONS_WINDOW_DAYS, type RecommendationsResponse } from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { LimitsService } from "../limits/limits.service";
import { SettingsService } from "../settings/settings.service";
import { withSavedTimeZone } from "../settings/time-zone.errors";
import { ActivityRepository } from "./activity.repository";
import { recommend } from "./recommendations.rules";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The busiest sites of the window are the only ones a suggestion can be about. */
const TOP_DOMAINS = 50;

/** Suggestions for the signed-in user from their own last 4 weeks. Nothing here logs: it is all domains. */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly settings: SettingsService,
    private readonly limits: LimitsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(userId: string): Promise<RecommendationsResponse> {
    assertUserScope(userId);
    const to = this.clock.now();
    const from = new Date(to.getTime() - RECOMMENDATIONS_WINDOW_DAYS * DAY_MS);
    const filters = { from, to };
    const { timeZone } = await this.settings.get(userId);
    const [top, first, { limits }] = await Promise.all([
      this.repository.domains(userId, filters, TOP_DOMAINS),
      this.repository.firstActivity(userId, filters),
      this.limits.list(userId),
    ]);
    const days = await withSavedTimeZone(() =>
      this.repository.domainDays(
        userId,
        filters,
        timeZone,
        top.map((d) => d.domain),
      ),
    );
    const recommendations = recommend({
      days,
      limits,
      dataSpanDays: first ? Math.floor((to.getTime() - first.getTime()) / DAY_MS) : 0,
      recentFrom: localDate(new Date(to.getTime() - 6 * DAY_MS), timeZone),
    });
    return { from: from.toISOString(), to: to.toISOString(), timeZone, recommendations };
  }
}

/** `YYYY-MM-DD` of `at` in `timeZone` (the name was checked when the user saved it). */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
