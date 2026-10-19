import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RetentionController } from "./retention.controller";
import { RetentionRepository } from "./retention.repository";
import { RetentionService } from "./retention.service";

/** Retention policies per type and per source, and the day count an incoming event gets. */
@Module({
  imports: [AuthModule],
  controllers: [RetentionController],
  providers: [RetentionRepository, RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
