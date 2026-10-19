import { Injectable, Logger } from "@nestjs/common";
import { resolveRetentionDays } from "@personal-api/contracts";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { type ExpiryCursor, RetentionRepository } from "./retention.repository";

const DAY_MS = 86_400_000;
export const RECOMPUTE_BATCH_SIZE = 1000;

export interface RecomputeOptions {
  batchSize?: number;
}

@Injectable()
export class RetentionRecomputeService {
  private readonly logger = new Logger(RetentionRecomputeService.name);

  constructor(private readonly repository: RetentionRepository) {}

  /**
   * Re-derives `expires_at` for one user's events from their current policies:
   * `received_at + days`, where `days` is the type policy, else the source policy, else the default
   * (what ingest does when no rule decides). Events a `set_retention` rule governs are skipped by
   * the repository. Idempotent: it writes only rows whose value would change, so a repeat, or a
   * run for a policy that changed again, ends in the same state. Returns how many events it changed.
   */
  async run(
    userId: string,
    { batchSize = RECOMPUTE_BATCH_SIZE }: RecomputeOptions = {},
  ): Promise<number> {
    assertUserScope(userId);
    const policies = await this.repository.daysByTarget(userId);
    let updated = 0;
    let cursor: ExpiryCursor | null = null;
    for (;;) {
      const page = await this.repository.expiryPage(userId, cursor, batchSize);
      const idsByDays = new Map<number, string[]>();
      for (const row of page) {
        const days = resolveRetentionDays({
          rule: null,
          type: policies.type.get(row.type) ?? null,
          source: policies.source.get(row.integrationId) ?? null,
        });
        if (row.expiresAt?.getTime() === row.receivedAt.getTime() + days * DAY_MS) continue;
        const ids = idsByDays.get(days);
        if (ids) ids.push(row.id);
        else idsByDays.set(days, [row.id]);
      }
      for (const [days, ids] of idsByDays) {
        updated += await this.repository.setExpiry(userId, ids, days);
      }
      const last = page.at(-1);
      if (last === undefined || page.length < batchSize) break;
      cursor = { occurredAt: last.occurredAt, id: last.id };
    }
    if (updated > 0) this.logger.log(`retention recompute changed ${updated} events`);
    return updated;
  }
}
