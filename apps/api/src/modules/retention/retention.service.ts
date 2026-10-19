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
import { JobsService } from "../../platform/jobs/jobs.service";
import { RECOMPUTE_DELAY_SECONDS, RETENTION_RECOMPUTE_QUEUE } from "./retention.jobs";
import { type PolicyDays, RetentionRepository } from "./retention.repository";

@Injectable()
export class RetentionService {
  constructor(
    private readonly repository: RetentionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobsService,
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
    const policy = await this.repository.upsert(userId, scope, target, days, this.clock.now());
    await this.requestRecompute(userId);
    return policy;
  }

  async remove(userId: string, scopeParam: string, targetParam: string): Promise<void> {
    assertUserScope(userId);
    const { scope, target } = parseTarget(scopeParam, targetParam);
    if (!(await this.repository.remove(userId, scope, target))) throw targetNotFound();
    await this.requestRecompute(userId);
  }

  /**
   * Asks the worker to re-derive the user's `expires_at` values, after a short delay (see
   * `RECOMPUTE_DELAY_SECONDS`). One waiting job per user: a burst of edits is one run. The job
   * carries only the user id. If the queue is down this throws after the policy was saved, and
   * repeating the (idempotent) request enqueues again.
   */
  private async requestRecompute(userId: string): Promise<void> {
    await this.jobs.enqueue(
      RETENTION_RECOMPUTE_QUEUE,
      { userId },
      { singletonKey: userId, startAfter: RECOMPUTE_DELAY_SECONDS },
    );
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
