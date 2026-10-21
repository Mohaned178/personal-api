import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SettingsModule } from "../settings/settings.module";
import { ActivityController } from "./activity.controller";
import { ActivityRepository } from "./activity.repository";
import { ActivityService } from "./activity.service";

/** Daily active time and per-domain totals, computed from focus segments and visits in SQL. */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [ActivityController],
  providers: [ActivityRepository, ActivityService],
})
export class ActivityModule {}
