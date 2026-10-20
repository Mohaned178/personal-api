import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type { EXPORT_EVENTS_FILE, EXPORT_MANIFEST_FILE } from "@personal-api/contracts";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import { isUuid } from "../../platform/db/uuid";

export const DEFAULT_EXPORT_DIR = "data/exports";

/**
 * Where export files live: `<EXPORT_DIR>/<exportId>/{events.ndjson.gz,manifest.json}`. The export
 * id is the only thing in a path, and it must be a UUID, so a path can never leave the directory.
 * The API (download, account deletion) and the worker (write, cleanup) share this directory.
 */
@Injectable()
export class ExportStorage {
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.root = resolve(config.EXPORT_DIR ?? DEFAULT_EXPORT_DIR);
  }

  dir(exportId: string): string {
    if (!isUuid(exportId)) throw new Error("export id must be a UUID");
    return join(this.root, exportId);
  }

  /** The path of one of the export's files. */
  file(exportId: string, name: typeof EXPORT_EVENTS_FILE | typeof EXPORT_MANIFEST_FILE): string {
    return join(this.dir(exportId), name);
  }

  async prepare(exportId: string): Promise<string> {
    const dir = this.dir(exportId);
    // Owner only: the files hold the user's browsing data.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Atomic within a directory: a reader sees the old file or the whole new one. */
  async publish(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  /** Idempotent: a directory that is already gone is fine. */
  async remove(exportId: string): Promise<void> {
    await rm(this.dir(exportId), { recursive: true, force: true });
  }

  /** Export directories on disk (names that are UUIDs); anything else in the directory is ignored. */
  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && isUuid(e.name)).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
