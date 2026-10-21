import { Inject, Injectable } from "@nestjs/common";
import {
  CATEGORY_LIMIT_REACHED_CODE,
  CATEGORY_NOT_FOUND_CODE,
  CATEGORY_PATTERN_TAKEN_CODE,
  CATEGORY_RULES_PER_USER_MAX,
  type CategoryListResponse,
  type CategoryRule,
  type CategoryRuleSave,
  PRESET_CATEGORY_DOMAINS,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { CategoriesRepository, type CategoryChangeResult } from "./categories.repository";

/**
 * Category overrides for one user. `userId` always comes from the session AuthContext. An unknown
 * id, someone else's id and a malformed id all give the same 404, so the API never confirms that
 * another user's override exists. Nothing here logs: a pattern is a domain.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly repository: CategoriesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<CategoryListResponse> {
    assertUserScope(userId);
    return {
      rules: await this.repository.list(userId),
      presets: {
        productive: [...PRESET_CATEGORY_DOMAINS.productive],
        distracting: [...PRESET_CATEGORY_DOMAINS.distracting],
      },
    };
  }

  /** Just the overrides, for the split. */
  async rules(userId: string): Promise<CategoryRule[]> {
    assertUserScope(userId);
    return this.repository.list(userId);
  }

  async create(userId: string, save: CategoryRuleSave): Promise<CategoryRule> {
    assertUserScope(userId);
    return changed(await this.repository.create(userId, save, this.clock.now()));
  }

  async replace(userId: string, id: string, save: CategoryRuleSave): Promise<CategoryRule> {
    assertUserScope(userId);
    if (!isUuid(id)) throw notFound();
    return changed(await this.repository.replace(userId, id, save, this.clock.now()));
  }

  async remove(userId: string, id: string): Promise<void> {
    assertUserScope(userId);
    if (!isUuid(id) || !(await this.repository.remove(userId, id))) throw notFound();
  }
}

function notFound(): AppException {
  return new AppException(404, CATEGORY_NOT_FOUND_CODE, "Category not found");
}

function changed(result: CategoryChangeResult): CategoryRule {
  if (result === "not_found") throw notFound();
  if (result === "pattern_taken") {
    throw new AppException(
      409,
      CATEGORY_PATTERN_TAKEN_CODE,
      "Pattern already has a category",
      "Change the existing one for that pattern instead",
    );
  }
  if (result === "limit_reached") {
    throw new AppException(
      409,
      CATEGORY_LIMIT_REACHED_CODE,
      "Category count reached",
      `A user can have at most ${CATEGORY_RULES_PER_USER_MAX} overrides`,
    );
  }
  return result;
}
