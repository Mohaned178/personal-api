import { Module } from "@nestjs/common";
import { DeletionsJobs } from "./deletions.jobs";
import { DeletionsRepository } from "./deletions.repository";
import { DeletionsRunService } from "./deletions-run.service";

/**
 * The bulk-deletion job handler and what it needs (the global DB, clock and jobs modules). The
 * worker imports this alone; the API gets it through `DeletionsModule`, so both processes create
 * the queue and only the worker (`work: true`) runs the handler.
 */
@Module({
  providers: [DeletionsRepository, DeletionsRunService, DeletionsJobs],
  exports: [DeletionsRepository],
})
export class DeletionsJobsModule {}
