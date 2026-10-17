import { Inject, Injectable } from "@nestjs/common";
import {
  DIAGNOSTICS_DEFAULT_HOURS,
  type DiagnosticsBucket,
  type DiagnosticsIntegration,
  type DiagnosticsQuery,
  type DiagnosticsResponse,
  heartbeatRequestSchema,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { DiagnosticsRepository, type IntegrationRow } from "./diagnostics.repository";

const HOUR_MS = 3_600_000;

/**
 * Counters and client-reported queue health for the caller's sources. `userId` always comes from
 * the session AuthContext. Job failures arrive with the first job handlers.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly repository: DiagnosticsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(userId: string, query: DiagnosticsQuery): Promise<DiagnosticsResponse> {
    assertUserScope(userId);
    const hours = query.hours ?? DIAGNOSTICS_DEFAULT_HOURS;
    const currentHour = Math.floor(this.clock.now().getTime() / HOUR_MS) * HOUR_MS;
    const start = currentHour - (hours - 1) * HOUR_MS;

    const [integrationRows, logRows] = await Promise.all([
      this.repository.listIntegrations(userId),
      this.repository.ingestionSince(userId, new Date(start)),
    ]);

    const byHour = new Map<number, DiagnosticsBucket>();
    for (let i = 0; i < hours; i++) {
      const t = start + i * HOUR_MS;
      byHour.set(t, {
        bucket: new Date(t).toISOString(),
        accepted: 0,
        duplicate: 0,
        dropped: 0,
        rejected: 0,
      });
    }
    for (const row of logRows) {
      const slot = byHour.get(Math.floor(row.bucket.getTime() / HOUR_MS) * HOUR_MS);
      if (!slot) continue;
      slot.accepted += row.accepted;
      slot.duplicate += row.duplicate;
      slot.dropped += row.dropped;
      slot.rejected += row.rejected;
    }

    return {
      integrations: integrationRows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .map(toDiagnosticsIntegration),
      ingestion: [...byHour.values()],
    };
  }
}

/** Explicit field list; a heartbeat that does not parse is shown as none rather than guessed at. */
export function toDiagnosticsIntegration(row: IntegrationRow): DiagnosticsIntegration {
  const heartbeat = heartbeatRequestSchema.safeParse(row.lastHeartbeat);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DiagnosticsIntegration["kind"],
    status: row.status as DiagnosticsIntegration["status"],
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    heartbeat: heartbeat.success ? heartbeat.data : null,
  };
}
