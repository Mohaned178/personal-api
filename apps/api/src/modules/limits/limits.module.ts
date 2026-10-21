import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LimitsController } from "./limits.controller";
import { LimitsRepository } from "./limits.repository";
import { LimitsService } from "./limits.service";

/** Daily site limits (M9-02): CRUD for the dashboard, and the list the extension config carries. */
@Module({
  imports: [AuthModule],
  controllers: [LimitsController],
  providers: [LimitsRepository, LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
