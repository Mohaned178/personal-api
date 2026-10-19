import { Inject, Injectable, Logger } from "@nestjs/common";
import { deletionFilterSchema } from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { DeletionsRepository } from "./deletions.repository";

export const DELETION_BATCH_SIZE = 1000;

export interface DeletionRunOptions {
  batchSize?: number;
}

@Injectable()
export class DeletionsRunService {
  private readonly logger = new Logger(DeletionsRunService.name);

  constructor(
    private readonly repository: DeletionsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Deletes the events of one deletion in batches, each its own short transaction, so ingest is
   * never blocked for long, and records progress after each. Idempotent: a finished deletion is
   * left alone, and a retry after a crash carries on with what is still there. A failure marks the
   * deletion `failed` and rethrows, so pg-boss retries it (which marks it `running` again).
   * Returns how many events this run removed; only counts are logged.
   */
  async run(
    userId: string,
    id: string,
    { batchSize = DELETION_BATCH_SIZE }: DeletionRunOptions = {},
  ): Promise<number> {
    assertUserScope(userId);
    const row = await this.repository.markRunning(userId, id);
    if (row === null) return 0;
    try {
      const filter = deletionFilterSchema.parse(row.filter);
      if (row.total === null) {
        const total = await this.repository.countMatching(userId, filter);
        await this.repository.setTotal(userId, id, total);
      }
      let removed = 0;
      for (;;) {
        const batch = await this.repository.deleteBatch(userId, filter, batchSize);
        if (batch === 0) break;
        removed += batch;
        await this.repository.addDeleted(userId, id, batch);
      }
      await this.repository.finish(userId, id, "completed", this.clock.now());
      if (removed > 0) this.logger.log(`bulk deletion removed ${removed} events`);
      return removed;
    } catch (error) {
      await this.repository.finish(userId, id, "failed", this.clock.now());
      throw error;
    }
  }
}
