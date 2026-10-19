import { Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { JobRegistry } from "../../platform/jobs/jobs.registry";
import { DeletionsRunService } from "./deletions-run.service";

export const BULK_DELETE_QUEUE = "deletions.run";

/**
 * How long "delete this integration's data" waits before it starts. The integration is revoked
 * first, but an ingest batch that was already past the key check can still commit; this is longer
 * than a request, so the job's final sweep sees that event too.
 */
export const INTEGRATION_DELETE_DELAY_SECONDS = 60;

/** Only ids: the filter is read from the `bulk_deletions` row when the job runs. */
export const deletionPayloadSchema = z.strictObject({
  userId: z.string().min(1),
  deletionId: z.uuid(),
});

/** Registers the bulk-deletion queue. Imported by both the API (which enqueues) and the worker. */
@Injectable()
export class DeletionsJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly runner: DeletionsRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      queue: BULK_DELETE_QUEUE,
      queueOptions: { retryLimit: 3, retryBackoff: true, expireInSeconds: 60 * 60 },
      handler: async (job) => {
        const payload = deletionPayloadSchema.safeParse(job.data);
        // The message never carries the payload: it can hold a user id.
        if (!payload.success) throw new Error(`${BULK_DELETE_QUEUE}: invalid job payload`);
        await this.runner.run(payload.data.userId, payload.data.deletionId);
      },
    });
  }
}
