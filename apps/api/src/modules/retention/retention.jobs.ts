import { Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { JobRegistry } from "../../platform/jobs/jobs.registry";
import { RetentionPurgeService } from "./retention-purge.service";
import { RetentionRecomputeService } from "./retention-recompute.service";

export const RETENTION_PURGE_QUEUE = "retention.purge";
export const RETENTION_RECOMPUTE_QUEUE = "retention.recompute";

/** Every hour on the hour, UTC. */
export const RETENTION_PURGE_CRON = "0 * * * *";

/**
 * How long a recompute waits after a policy change. An ingest batch that read the old policies
 * just before the change can commit after it; this is longer than a request, so the recompute
 * (which reads the policies when it runs) sees that event too. Edits inside the window fold into
 * the waiting job, so for the later ones the margin is shorter; a repeat edit re-checks.
 */
export const RECOMPUTE_DELAY_SECONDS = 60;

/** Only the user to recompute. The days come from the policies at run time, never from the job. */
export const recomputePayloadSchema = z.strictObject({ userId: z.string().min(1) });

/** Registers the retention queues. Imported by both the API (which enqueues) and the worker. */
@Injectable()
export class RetentionJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly purge: RetentionPurgeService,
    private readonly recompute: RetentionRecomputeService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      queue: RETENTION_PURGE_QUEUE,
      schedule: RETENTION_PURGE_CRON,
      // `exclusive`: a tick that arrives while the last run is still going is dropped, not stacked.
      queueOptions: { policy: "exclusive", expireInSeconds: 30 * 60 },
      handler: async () => {
        await this.purge.run();
      },
    });
    this.registry.register({
      queue: RETENTION_RECOMPUTE_QUEUE,
      // `stately` with a per-user key: one waiting job per user (it reads the policies when it
      // runs, so later changes are already covered) and one running, so a change that lands
      // during a run still gets its own follow-up run.
      queueOptions: { policy: "stately", expireInSeconds: 60 * 60 },
      handler: async (job) => {
        const payload = recomputePayloadSchema.safeParse(job.data);
        // The message never carries the payload: it can hold a user id.
        if (!payload.success) throw new Error(`${RETENTION_RECOMPUTE_QUEUE}: invalid job payload`);
        await this.recompute.run(payload.data.userId);
      },
    });
  }
}
