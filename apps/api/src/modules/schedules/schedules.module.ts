import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SchedulesController } from "./schedules.controller";
import { SchedulesRepository } from "./schedules.repository";
import { SchedulesService } from "./schedules.service";

/** Block schedules (M9-06): CRUD for the dashboard, and the enabled ones the extension config carries. */
@Module({
  imports: [AuthModule],
  controllers: [SchedulesController],
  providers: [SchedulesRepository, SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
