import { Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { JobRegistry } from "../../platform/jobs/jobs.registry";
import { ExportsCleanupService } from "./exports-cleanup.service";
import { ExportsRunService } from "./exports-run.service";

export const EXPORT_RUN_QUEUE = "exports.run";
export const EXPORT_CLEANUP_QUEUE = "exports.cleanup";

/** Every hour at minute 30, UTC (the retention purge runs on the hour). */
export const EXPORT_CLEANUP_CRON = "30 * * * *";

/** Only ids: the filter is read from the `exports` row when the job runs. */
export const exportPayloadSchema = z.strictObject({
  userId: z.string().min(1),
  exportId: z.uuid(),
});

/** Registers the export queues. Imported by both the API (which enqueues) and the worker. */
@Injectable()
export class ExportsJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly runner: ExportsRunService,
    private readonly cleanup: ExportsCleanupService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      queue: EXPORT_RUN_QUEUE,
      queueOptions: { retryLimit: 3, retryBackoff: true, expireInSeconds: 60 * 60 },
      handler: async (job) => {
        const payload = exportPayloadSchema.safeParse(job.data);
        // The message never carries the payload: it can hold a user id.
        if (!payload.success) throw new Error(`${EXPORT_RUN_QUEUE}: invalid job payload`);
        await this.runner.run(payload.data.userId, payload.data.exportId);
      },
    });
    this.registry.register({
      queue: EXPORT_CLEANUP_QUEUE,
      schedule: EXPORT_CLEANUP_CRON,
      // `exclusive`: a tick that arrives while the last run is still going is dropped, not stacked.
      queueOptions: { policy: "exclusive", expireInSeconds: 30 * 60 },
      handler: async () => {
        await this.cleanup.run();
      },
    });
  }
}
