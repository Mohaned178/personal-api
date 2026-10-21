import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FocusController } from "./focus.controller";
import { FocusRepository } from "./focus.repository";
import { FocusService } from "./focus.service";

/** Focus sessions (M9-06): start and end for the dashboard, and the running one the extension config carries. */
@Module({
  imports: [AuthModule],
  controllers: [FocusController],
  providers: [FocusRepository, FocusService],
  exports: [FocusService],
})
export class FocusModule {}
