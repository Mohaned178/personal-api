import { Global, Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../../platform/clock/clock";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";
import { IngestKeyGuard } from "./ingest-key.guard";

/** M1-03 (test-writer stub wiring). The builder should move CLOCK into its own global ClockModule. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    ApiKeysRepository,
    ApiKeysService,
    IngestKeyGuard,
  ],
  exports: [CLOCK, ApiKeysService, IngestKeyGuard],
})
export class KeysModule {}
