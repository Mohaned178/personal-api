import { Inject, Injectable } from "@nestjs/common";
import {
  RETENTION_DEFAULT_DAYS,
  RETENTION_TARGET_INVALID_CODE,
  RETENTION_TARGET_NOT_FOUND_CODE,
  type RetentionPolicy,
  type RetentionResponse,
  type RetentionScope,
  retentionScopeSchema,
  retentionTargetSchema,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { type PolicyDays, RetentionRepository } from "./retention.repository";

@Injectable()
export class RetentionService {
  constructor(
    private readonly repository: RetentionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<RetentionResponse> {
    assertUserScope(userId);
    return { defaultDays: RETENTION_DEFAULT_DAYS, policies: await this.repository.list(userId) };
  }

  /** The policies behind `resolveRetentionDays` for one batch. */
  daysByTarget(userId: string): Promise<PolicyDays> {
    assertUserScope(userId);
    return this.repository.daysByTarget(userId);
  }

  /**
   * Creates or replaces the policy for one type or source. A source must be one of the user's own
   * integrations; anyone else's id answers 404, the same as an unknown one (invariant 4).
   */
  async put(
    userId: string,
    scopeParam: string,
    targetParam: string,
    days: number,
  ): Promise<RetentionPolicy> {
    assertUserScope(userId);
    const { scope, target } = parseTarget(scopeParam, targetParam);
    if (scope === "source" && !(await this.repository.ownsIntegration(userId, target))) {
      throw targetNotFound();
    }
    return this.repository.upsert(userId, scope, target, days, this.clock.now());
  }

  async remove(userId: string, scopeParam: string, targetParam: string): Promise<void> {
    assertUserScope(userId);
    const { scope, target } = parseTarget(scopeParam, targetParam);
    if (!(await this.repository.remove(userId, scope, target))) throw targetNotFound();
  }
}

function parseTarget(
  scopeParam: string,
  targetParam: string,
): { scope: RetentionScope; target: string } {
  const scope = retentionScopeSchema.safeParse(scopeParam);
  const target = scope.success ? retentionTargetSchema(scope.data).safeParse(targetParam) : null;
  if (!scope.success || target === null || !target.success) {
    throw new AppException(400, RETENTION_TARGET_INVALID_CODE, "Invalid retention target");
  }
  return { scope: scope.data, target: target.data };
}

function targetNotFound(): AppException {
  return new AppException(404, RETENTION_TARGET_NOT_FOUND_CODE, "Retention target not found");
}
