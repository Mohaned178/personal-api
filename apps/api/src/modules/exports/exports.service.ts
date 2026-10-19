import { access } from "node:fs/promises";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  EXPORT_EVENTS_FILE,
  EXPORT_EXPIRED_CODE,
  EXPORT_MANIFEST_FILE,
  EXPORT_NOT_FOUND_CODE,
  EXPORT_NOT_READY_CODE,
  EXPORTS_LIST_LIMIT,
  type Export,
  type ExportFilter,
  type ExportResponse,
  exportFilterSchema,
  type ListExportsResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { JobsService } from "../../platform/jobs/jobs.service";
import { AccountDeletionSteps } from "../account/account.steps";
import { EXPORT_RUN_QUEUE } from "./exports.jobs";
import { type ExportRow, ExportsRepository } from "./exports.repository";
import { ExportStorage } from "./exports.storage";

export type ExportFileName = typeof EXPORT_EVENTS_FILE | typeof EXPORT_MANIFEST_FILE;

/**
 * Exports for one user. `userId` always comes from the session AuthContext. An unknown id,
 * someone else's id and a malformed id all give the same 404.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  constructor(
    private readonly repository: ExportsRepository,
    private readonly storage: ExportStorage,
    private readonly jobs: JobsService,
    private readonly deletionSteps: AccountDeletionSteps,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Account deletion removes the user's export files before it deletes the rows that name them. */
  onModuleInit(): void {
    this.deletionSteps.register({
      name: "exports.files",
      run: async (userId) => {
        assertUserScope(userId);
        for (const id of await this.repository.listIds(userId)) await this.storage.remove(id);
      },
    });
  }

  /** Records the export and enqueues its job. The job carries ids only. */
  async create(userId: string, filter: ExportFilter = {}): Promise<ExportResponse> {
    assertUserScope(userId);
    const row = await this.repository.create(userId, filter);
    await this.jobs.enqueue(EXPORT_RUN_QUEUE, { userId, exportId: row.id });
    return { export: toExport(row) };
  }

  async list(userId: string): Promise<ListExportsResponse> {
    assertUserScope(userId);
    const rows = await this.repository.list(userId, EXPORTS_LIST_LIMIT);
    return { exports: rows.map(toExport) };
  }

  async get(userId: string, id: string): Promise<ExportResponse> {
    return { export: toExport(await this.find(userId, id)) };
  }

  /**
   * The path of a file of a completed export that can still be downloaded: 404 for an unknown
   * export, 409 while it is not completed, 410 once its window has closed or its file is gone.
   */
  async fileFor(userId: string, id: string, name: ExportFileName): Promise<string> {
    const row = await this.find(userId, id);
    if (row.status !== "completed") {
      throw new AppException(409, EXPORT_NOT_READY_CODE, "The export is not ready");
    }
    const path = this.storage.file(row.id, name);
    const expired = row.expiresAt !== null && row.expiresAt.getTime() <= this.clock.now().getTime();
    const present = expired
      ? false
      : await access(path).then(
          () => true,
          () => false,
        );
    if (!present) throw new AppException(410, EXPORT_EXPIRED_CODE, "The export has expired");
    return path;
  }

  private async find(userId: string, id: string): Promise<ExportRow> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.findById(userId, id) : null;
    if (!row) throw new AppException(404, EXPORT_NOT_FOUND_CODE, "Export not found");
    return row;
  }
}

/** Explicit field list: the user id and the file path stay out of the response. */
export function toExport(row: ExportRow): Export {
  return {
    id: row.id,
    status: row.status as Export["status"],
    filter: exportFilterSchema.parse(row.filter),
    eventCount: row.eventCount,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}
