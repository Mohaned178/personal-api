import { Inject, Injectable, Logger } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { RetentionPurgeRepository } from "./retention-purge.repository";

export const PURGE_BATCH_SIZE = 1000;
/** One run removes at most 200 000 events; the next hourly run carries on, so a run always ends. */
export const PURGE_MAX_BATCHES = 200;

export interface PurgeOptions {
  batchSize?: number;
  maxBatches?: number;
}

@Injectable()
export class RetentionPurgeService {
  private readonly logger = new Logger(RetentionPurgeService.name);

  constructor(
    private readonly repository: RetentionPurgeRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Deletes expired events in batches, each its own short transaction, so ingest is never blocked
   * for long. Safe to repeat or overlap: it holds no state, and a second run just finds fewer rows.
   * Returns how many events it removed; only that count is logged.
   */
  async run({
    batchSize = PURGE_BATCH_SIZE,
    maxBatches = PURGE_MAX_BATCHES,
  }: PurgeOptions = {}): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const removed = await this.repository.purgeExpired(this.clock.now(), batchSize);
      total += removed;
      if (removed < batchSize) break;
    }
    if (total > 0) this.logger.log(`retention purge removed ${total} events`);
    return total;
  }
}
