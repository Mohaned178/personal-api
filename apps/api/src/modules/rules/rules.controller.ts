import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import type {
  DeleteRuleResponse,
  RuleListResponse,
  RuleResponse,
  TestRuleResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { RuleDefinitionDto, TestRuleDto } from "./rules.dto";
import { RulesService } from "./rules.service";

/**
 * Dashboard routes for rules. The user is the session's; the body never names a user, and the
 * server sets the rule id. The guard runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/rules")
@UseGuards(SessionGuard)
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<RuleListResponse> {
    return this.rules.list(auth.userId);
  }

  /** Dry run against a sample event. Stores nothing. */
  @Post("test")
  @HttpCode(200)
  test(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: TestRuleDto,
  ): Promise<TestRuleResponse> {
    return this.rules.test(auth.userId, body);
  }

  @Post()
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: RuleDefinitionDto,
  ): Promise<RuleResponse> {
    return this.rules.create(auth.userId, body);
  }

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<RuleResponse> {
    return this.rules.get(auth.userId, id);
  }

  /** Replaces the whole definition. */
  @Put(":id")
  replace(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: RuleDefinitionDto,
  ): Promise<RuleResponse> {
    return this.rules.replace(auth.userId, id, body);
  }

  @Delete(":id")
  remove(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<DeleteRuleResponse> {
    return this.rules.remove(auth.userId, id);
  }
}
