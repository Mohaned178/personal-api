import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { KeysModule } from "../keys/keys.module";
import { SettingsModule } from "../settings/settings.module";
import { EndpointsController } from "./endpoints.controller";
import { EndpointsRepository } from "./endpoints.repository";
import { EndpointsService } from "./endpoints.service";
import { MeController } from "./me.controller";
import { SavedQueryRepository } from "./saved-query.repository";
import { SavedQueryService } from "./saved-query.service";

/**
 * User-defined endpoints: the saved-query runner (M5-04), endpoint CRUD with its scoped read keys,
 * the preview, and `GET /v1/me/:slug` (M5-05).
 */
@Module({
  imports: [AuthModule, KeysModule, SettingsModule],
  controllers: [EndpointsController, MeController],
  providers: [EndpointsRepository, EndpointsService, SavedQueryRepository, SavedQueryService],
  exports: [SavedQueryService],
})
export class EndpointsModule {}
