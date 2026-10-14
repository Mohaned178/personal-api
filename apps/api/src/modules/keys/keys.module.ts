import { Module } from "@nestjs/common";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";
import { IngestKeyGuard } from "./ingest-key.guard";

/**
 * API keys: generation, hashed storage, ingest-key authentication and IngestKeyGuard. A module
 * whose controllers use `@UseGuards(IngestKeyGuard)` imports this one. `CLOCK` comes from the
 * global ClockModule.
 */
@Module({
  providers: [ApiKeysRepository, ApiKeysService, IngestKeyGuard],
  exports: [ApiKeysService, IngestKeyGuard],
})
export class KeysModule {}
