import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  EXPORT_EVENTS_FILE,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_FILE,
  EXPORT_TTL_HOURS,
  type ExportFilter,
  exportFilterSchema,
  exportManifestSchema,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import type { EventsCursor } from "../events/events.cursor";
import { type EventFilters, EventsRepository } from "../events/events.repository";
import { toStoredEvent } from "../events/events.service";
import { ExportsRepository } from "./exports.repository";
import { ExportStorage } from "./exports.storage";

export const EXPORT_BATCH_SIZE = 500;

export interface ExportRunOptions {
  batchSize?: number;
}

@Injectable()
export class ExportsRunService {
  private readonly logger = new Logger(ExportsRunService.name);

  constructor(
    private readonly repository: ExportsRepository,
    private readonly eventsRepository: EventsRepository,
    private readonly storage: ExportStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Writes one export: the user's matching events, newest first, as NDJSON gzip, then its manifest.
   * Both files are written under a temporary name and renamed, so a download never sees half a
   * file. Idempotent: a completed export is left alone, and a retry (after a crash or a failure)
   * starts the files over. A failure removes what was written, marks the export `failed` and
   * rethrows, so pg-boss retries it. Only counts are logged (invariant 6).
   * Returns how many events this run wrote.
   */
  async run(
    userId: string,
    id: string,
    { batchSize = EXPORT_BATCH_SIZE }: ExportRunOptions = {},
  ): Promise<number> {
    assertUserScope(userId);
    const row = await this.repository.markRunning(userId, id);
    if (row === null) return 0;
    try {
      const filter = exportFilterSchema.parse(row.filter);
      await this.storage.prepare(id);
      const eventsFile = this.storage.file(id, EXPORT_EVENTS_FILE);
      const manifestFile = this.storage.file(id, EXPORT_MANIFEST_FILE);

      const hash = createHash("sha256");
      let bytes = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      const counter = { count: 0 };
      const tmpEvents = `${eventsFile}.tmp`;
      await pipeline(
        Readable.from(this.lines(userId, filter, batchSize, counter)),
        createGzip(),
        tap,
        createWriteStream(tmpEvents),
      );
      await this.storage.publish(tmpEvents, eventsFile);

      const now = this.clock.now();
      const manifest = exportManifestSchema.parse({
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportId: id,
        generatedAt: now.toISOString(),
        filter,
        eventCount: counter.count,
        file: { name: EXPORT_EVENTS_FILE, sha256: hash.digest("hex"), bytes },
      });
      const tmpManifest = `${manifestFile}.tmp`;
      await writeFile(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      await this.storage.publish(tmpManifest, manifestFile);

      await this.repository.complete(userId, id, {
        filePath: `${id}/${EXPORT_EVENTS_FILE}`,
        eventCount: counter.count,
        sizeBytes: bytes,
        finishedAt: now,
        expiresAt: new Date(now.getTime() + EXPORT_TTL_HOURS * 3_600_000),
      });
      this.logger.log(`export wrote ${counter.count} events`);
      return counter.count;
    } catch (error) {
      await this.storage.remove(id).catch(() => undefined);
      await this.repository.fail(userId, id, this.clock.now());
      throw error;
    }
  }

  /** One JSON line per event, read in keyset pages on `(occurred_at, id)`, newest first. */
  private async *lines(
    userId: string,
    filter: ExportFilter,
    batchSize: number,
    counter: { count: number },
  ): AsyncGenerator<string> {
    const base: EventFilters = {
      integrationId: filter.source,
      type: filter.type,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      domain: filter.domain,
    };
    let after: EventsCursor | undefined;
    for (;;) {
      const rows = await this.eventsRepository.list(userId, { ...base, after }, batchSize);
      for (const row of rows) {
        counter.count += 1;
        yield `${JSON.stringify(toStoredEvent(row))}\n`;
      }
      const last = rows.at(-1);
      if (rows.length < batchSize || !last) return;
      after = { occurredAt: last.occurredAt, id: last.id };
    }
  }
}
