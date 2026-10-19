import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DeletionsController } from "./deletions.controller";
import { DeletionsService } from "./deletions.service";
import { DeletionsJobsModule } from "./deletions-jobs.module";

/** Start and follow bulk deletions of events (by filter, or all of one integration's). */
@Module({
  imports: [AuthModule, DeletionsJobsModule],
  controllers: [DeletionsController],
  providers: [DeletionsService],
  exports: [DeletionsService],
})
export class DeletionsModule {}
