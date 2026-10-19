import { Module } from "@nestjs/common";
import { RetentionJobs } from "./retention.jobs";
import { RetentionRepository } from "./retention.repository";
import { RetentionPurgeRepository } from "./retention-purge.repository";
import { RetentionPurgeService } from "./retention-purge.service";
import { RetentionRecomputeService } from "./retention-recompute.service";

/**
 * The retention job handlers and what they need (the global DB, clock and jobs modules). The
 * worker imports this alone; the API gets it through `RetentionModule`, so both processes create
 * the queues and only the worker (`work: true`) runs the handlers.
 */
@Module({
  providers: [
    RetentionRepository,
    RetentionPurgeRepository,
    RetentionPurgeService,
    RetentionRecomputeService,
    RetentionJobs,
  ],
  exports: [RetentionPurgeService, RetentionRecomputeService],
})
export class RetentionJobsModule {}
