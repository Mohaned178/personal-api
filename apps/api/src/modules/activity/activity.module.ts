import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LimitsModule } from "../limits/limits.module";
import { SettingsModule } from "../settings/settings.module";
import { ActivityController } from "./activity.controller";
import { ActivityRepository } from "./activity.repository";
import { ActivityService } from "./activity.service";
import { RecommendationsController } from "./recommendations.controller";
import { RecommendationsService } from "./recommendations.service";

/**
 * Daily active time and per-domain totals, computed from focus segments and visits in SQL, and the
 * recommendations (M9-04) built from them.
 */
@Module({
  imports: [AuthModule, SettingsModule, LimitsModule],
  controllers: [ActivityController, RecommendationsController],
  providers: [ActivityRepository, ActivityService, RecommendationsService],
})
export class ActivityModule {}
