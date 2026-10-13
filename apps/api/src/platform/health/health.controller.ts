import { Controller, Get } from "@nestjs/common";
import { AppException } from "../errors/problem";
import { ReadinessRegistry } from "./readiness";

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessRegistry) {}

  @Get("healthz")
  healthz() {
    return { status: "ok" };
  }

  @Get("readyz")
  async readyz() {
    const result = await this.readiness.run();
    if (!result.ready) {
      throw new AppException(503, "health.not_ready", "service unavailable", undefined, {
        checks: result.checks,
      });
    }
    return { status: "ok", checks: result.checks };
  }
}
