import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { SavedQueryRepository } from "./saved-query.repository";
import { SavedQueryService } from "./saved-query.service";

/**
 * User-defined endpoints. M5-04 is the saved-query compiler and runner; M5-05 adds the endpoint
 * CRUD, `GET /v1/me/:slug` and the controller.
 */
@Module({
  imports: [SettingsModule],
  providers: [SavedQueryRepository, SavedQueryService],
  exports: [SavedQueryService],
})
export class EndpointsModule {}
