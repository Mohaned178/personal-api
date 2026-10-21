import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { GoalsController } from "./goals.controller";
import { GoalsRepository } from "./goals.repository";
import { GoalsService } from "./goals.service";

/** Daily goals on a category (M9-07): "under an hour of distracting sites". */
@Module({
  imports: [AuthModule],
  controllers: [GoalsController],
  providers: [GoalsRepository, GoalsService],
})
export class GoalsModule {}
