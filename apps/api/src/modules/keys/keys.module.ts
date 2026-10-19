import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";
import { IngestKeyGuard } from "./ingest-key.guard";
import { KeysController } from "./keys.controller";
import { ReadKeyGuard } from "./read-key.guard";

/**
 * API keys: generation, hashed storage, ingest-key and read-key authentication, IngestKeyGuard
 * and ReadKeyGuard, and the session routes for read keys (`/v1/keys`). A module whose controllers
 * use `@UseGuards(IngestKeyGuard)` or `@UseGuards(ReadKeyGuard)` imports this one. `CLOCK` comes
 * from the global ClockModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [KeysController],
  providers: [ApiKeysRepository, ApiKeysService, IngestKeyGuard, ReadKeyGuard],
  exports: [ApiKeysService, IngestKeyGuard, ReadKeyGuard],
})
export class KeysModule {}
