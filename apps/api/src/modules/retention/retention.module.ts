import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RetentionController } from "./retention.controller";
import { RetentionRepository } from "./retention.repository";
import { RetentionService } from "./retention.service";
import { RetentionJobsModule } from "./retention-jobs.module";

/** Retention policies per type and per source, and the day count an incoming event gets. */
@Module({
  imports: [AuthModule, RetentionJobsModule],
  controllers: [RetentionController],
  providers: [RetentionRepository, RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
