import { Global, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ReadinessRegistry } from "./readiness";

@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessRegistry],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
