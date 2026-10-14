import { Module } from "@nestjs/common";
import { KeysModule } from "../keys/keys.module";
import { IngestController } from "./ingest.controller";
import { IngestRepository } from "./ingest.repository";
import { IngestService } from "./ingest.service";

/**
 * `POST /v1/ingest/events`: per-item validation, storage with dedupe, hourly counters. The 256 KB
 * body limit for its route is set where the body parser is configured (AppModule). `CLOCK` comes
 * from the global ClockModule.
 */
@Module({
  imports: [KeysModule],
  controllers: [IngestController],
  providers: [IngestRepository, IngestService],
})
export class IngestModule {}
