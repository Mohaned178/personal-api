import { Module } from "@nestjs/common";
import { EventsRepository } from "../events/events.repository";
import { ExportsJobs } from "./exports.jobs";
import { ExportsRepository } from "./exports.repository";
import { ExportStorage } from "./exports.storage";
import { ExportsCleanupRepository } from "./exports-cleanup.repository";
import { ExportsCleanupService } from "./exports-cleanup.service";
import { ExportsRunService } from "./exports-run.service";

/**
 * The export job handlers and what they need (the global config, DB, clock and jobs modules). The
 * worker imports this alone; the API gets it through `ExportsModule`, so both processes create the
 * queues and only the worker (`work: true`) runs the handlers.
 */
@Module({
  providers: [
    EventsRepository,
    ExportsRepository,
    ExportsCleanupRepository,
    ExportStorage,
    ExportsRunService,
    ExportsCleanupService,
    ExportsJobs,
  ],
  exports: [ExportsRepository, ExportStorage],
})
export class ExportsJobsModule {}
