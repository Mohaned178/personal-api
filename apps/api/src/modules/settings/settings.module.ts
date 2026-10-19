import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SettingsController } from "./settings.controller";
import { SettingsRepository } from "./settings.repository";
import { SettingsService } from "./settings.service";
import { TimeZoneCatalog } from "./time-zone.catalog";

/** Per-user settings (the time zone for activity aggregates). */
@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsRepository, SettingsService, TimeZoneCatalog],
  exports: [SettingsService],
})
export class SettingsModule {}
