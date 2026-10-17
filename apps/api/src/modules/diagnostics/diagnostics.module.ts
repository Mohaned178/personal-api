import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DiagnosticsController } from "./diagnostics.controller";
import { DiagnosticsRepository } from "./diagnostics.repository";
import { DiagnosticsService } from "./diagnostics.service";

/** Ingestion counters per hour and each source's last-seen and heartbeat, for the Health page. */
@Module({
  imports: [AuthModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsRepository, DiagnosticsService],
})
export class DiagnosticsModule {}
