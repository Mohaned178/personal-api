import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RuleSetProvider } from "./rule-set.provider";
import { RulesController } from "./rules.controller";
import { RulesRepository } from "./rules.repository";
import { RulesService } from "./rules.service";

/** Rules CRUD, rule-set versioning with history snapshots, and the dry-run endpoint. */
@Module({
  imports: [AuthModule],
  controllers: [RulesController],
  providers: [RulesRepository, RulesService, RuleSetProvider],
  exports: [RulesService, RuleSetProvider],
})
export class RulesModule {}
