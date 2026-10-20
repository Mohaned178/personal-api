import { Inject, Injectable } from "@nestjs/common";
import {
  DELETION_NOT_FOUND_CODE,
  type Deletion,
  type DeletionFilter,
  type DeletionResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { JobsService } from "../../platform/jobs/jobs.service";
import { BULK_DELETE_QUEUE, INTEGRATION_DELETE_DELAY_SECONDS } from "./deletions.jobs";
import { type DeletionRow, DeletionsRepository } from "./deletions.repository";

/**
 * Bulk deletions for one user. `userId` always comes from the session AuthContext. An unknown id,
 * someone else's id and a malformed id all give the same 404.
 */
@Injectable()
export class DeletionsService {
  constructor(
    private readonly repository: DeletionsRepository,
    private readonly jobs: JobsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Records the deletion and enqueues its job. The job carries ids only. If the job cannot be
   * enqueued the row is marked `failed` (and the error rethrown), so it is not left `queued` for
   * a job that will never run.
   */
  async start(
    userId: string,
    kind: "events" | "integration",
    filter: DeletionFilter,
  ): Promise<Deletion> {
    assertUserScope(userId);
    const row = await this.repository.create(userId, kind, filter);
    try {
      await this.jobs.enqueue(
        BULK_DELETE_QUEUE,
        { userId, deletionId: row.id },
        kind === "integration" ? { startAfter: INTEGRATION_DELETE_DELAY_SECONDS } : undefined,
      );
    } catch (error) {
      await this.repository
        .finish(userId, row.id, "failed", this.clock.now())
        .catch(() => undefined);
      throw error;
    }
    return toDeletion(row);
  }

  async get(userId: string, id: string): Promise<DeletionResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.findById(userId, id) : null;
    if (!row) throw new AppException(404, DELETION_NOT_FOUND_CODE, "Deletion not found");
    return { deletion: toDeletion(row) };
  }
}

/** Explicit field list: the filter and the user id stay out of the response. */
export function toDeletion(row: DeletionRow): Deletion {
  return {
    id: row.id,
    kind: row.kind as Deletion["kind"],
    status: row.status as Deletion["status"],
    total: row.total,
    deleted: row.deleted,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}
