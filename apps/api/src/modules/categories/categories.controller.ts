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
import type { CategoryListResponse, CategoryRule } from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { CategoryRuleSaveDto } from "./categories.dto";
import { CategoriesService } from "./categories.service";

/**
 * Dashboard routes for category overrides. The user is the session's; the body never names a user,
 * and the server sets the id. The guard runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/categories")
@UseGuards(SessionGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<CategoryListResponse> {
    return this.categories.list(auth.userId);
  }

  @Post()
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: CategoryRuleSaveDto,
  ): Promise<CategoryRule> {
    return this.categories.create(auth.userId, body);
  }

  /** Replaces the whole override. */
  @Put(":id")
  replace(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: CategoryRuleSaveDto,
  ): Promise<CategoryRule> {
    return this.categories.replace(auth.userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentAuth("session") auth: SessionAuthContext, @Param("id") id: string): Promise<void> {
    return this.categories.remove(auth.userId, id);
  }
}
