import { Inject, Injectable, Logger } from "@nestjs/common";
import { EXPORT_TTL_HOURS } from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { ExportStorage } from "./exports.storage";
import { ExportsCleanupRepository } from "./exports-cleanup.repository";

export const EXPORT_CLEANUP_BATCH = 100;

@Injectable()
export class ExportsCleanupService {
  private readonly logger = new Logger(ExportsCleanupService.name);

  constructor(
    private readonly repository: ExportsCleanupRepository,
    private readonly storage: ExportStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Removes the files and then the rows of exports whose download window has closed, or that never
   * completed within a window of their own. Then removes export directories that no row owns (an
   * account deleted during a run leaves one). Files go first: if removing them throws, the row
   * stays and the next run tries again. Idempotent. Returns how many exports and directories it
   * removed; only counts are logged.
   */
  async run(batch = EXPORT_CLEANUP_BATCH): Promise<number> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - EXPORT_TTL_HOURS * 3_600_000);
    let removed = 0;
    for (;;) {
      const due = await this.repository.findDue(now, staleBefore, batch);
      if (due.length === 0) break;
      for (const id of due) await this.storage.remove(id);
      await this.repository.deleteByIds(due);
      removed += due.length;
    }
    const onDisk = await this.storage.listIds();
    for (let i = 0; i < onDisk.length; i += batch) {
      const chunk = onDisk.slice(i, i + batch);
      const owned = new Set(await this.repository.existing(chunk));
      for (const id of chunk) {
        if (owned.has(id)) continue;
        await this.storage.remove(id);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.log(`export cleanup removed ${removed} exports`);
    return removed;
  }
}
