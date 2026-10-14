import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsRepository } from "./integrations.repository";
import { IntegrationsService } from "./integrations.service";

/** Sources of events: create (with the first ingest key), list, get, rename, revoke. */
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsRepository, IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
