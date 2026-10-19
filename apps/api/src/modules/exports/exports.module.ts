import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthModule } from "../auth/auth.module";
import { ExportsController } from "./exports.controller";
import { ExportsService } from "./exports.service";
import { ExportsJobsModule } from "./exports-jobs.module";

/** Start, follow and download data exports; registers the export-file step of account deletion. */
@Module({
  imports: [AuthModule, AccountModule, ExportsJobsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
