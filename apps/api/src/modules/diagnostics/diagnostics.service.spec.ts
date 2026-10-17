import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import type {
  DiagnosticsRepository,
  IngestionLogRow,
  IntegrationRow,
} from "./diagnostics.repository";
import { DiagnosticsService } from "./diagnostics.service";

const NOW = "2026-10-17T10:30:00.000Z";
const HOUR = 3_600_000;
const hourStart = Date.parse("2026-10-17T10:00:00.000Z");
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";

function integration(over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: ID_1,
    userId: "u1",
    kind: "browser-extension",
    name: "Work laptop",
    defaultPolicy: "deny",
    status: "active",
    lastSeenAt: null,
    lastHeartbeat: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

function logRow(hoursAgo: number, over: Partial<IngestionLogRow> = {}): IngestionLogRow {
  return {
    id: crypto.randomUUID(),
    userId: "u1",
    integrationId: ID_1,
    bucket: new Date(hourStart - hoursAgo * HOUR),
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    rejected: 0,
    byReason: {},
    ...over,
  };
}

function service(integrations: IntegrationRow[], logs: IngestionLogRow[]) {
  const calls: { since: Date }[] = [];
  const repo = {
    listIntegrations: async () => integrations,
    ingestionSince: async (_userId: string, since: Date) => {
      calls.push({ since });
      return logs;
    },
  } as unknown as DiagnosticsRepository;
  return { svc: new DiagnosticsService(repo, new FakeClock(NOW)), calls };
}

describe("DiagnosticsService", () => {
  it("returns one zero-filled bucket per hour, oldest first, ending with the current hour", async () => {
    const { svc, calls } = service([], []);
    const res = await svc.get("u1", { hours: 3 });
    expect(res.ingestion.map((b) => b.bucket)).toEqual([
      "2026-10-17T08:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
      "2026-10-17T10:00:00.000Z",
    ]);
    expect(
      res.ingestion.every((b) => b.accepted + b.duplicate + b.dropped + b.rejected === 0),
    ).toBe(true);
    expect(calls[0]?.since.toISOString()).toBe("2026-10-17T08:00:00.000Z");
  });

  it("defaults to 24 hours", async () => {
    const { svc } = service([], []);
    expect((await svc.get("u1", {})).ingestion).toHaveLength(24);
  });

  it("sums the counters of every source into the hour they belong to", async () => {
    const { svc } = service(
      [],
      [
        logRow(0, { accepted: 5, duplicate: 1 }),
        logRow(0, { accepted: 2, dropped: 3, integrationId: ID_2 }),
        logRow(1, { rejected: 4 }),
      ],
    );
    const res = await svc.get("u1", { hours: 2 });
    expect(res.ingestion[1]).toMatchObject({ accepted: 7, duplicate: 1, dropped: 3, rejected: 0 });
    expect(res.ingestion[0]).toMatchObject({ accepted: 0, rejected: 4 });
  });

  it("ignores a row outside the window", async () => {
    const { svc } = service([], [logRow(10, { accepted: 9 })]);
    const res = await svc.get("u1", { hours: 2 });
    expect(res.ingestion.reduce((n, b) => n + b.accepted, 0)).toBe(0);
  });

  it("maps sources with last seen and heartbeat, and no heartbeat when unset or invalid", async () => {
    const heartbeat = {
      queueDepth: 12,
      oldestQueuedAgeMs: 5000,
      droppedCount: 0,
      clientVersion: "0.1.0",
    };
    const { svc } = service(
      [
        integration({
          id: ID_1,
          lastSeenAt: new Date("2026-10-17T10:00:00.000Z"),
          lastHeartbeat: heartbeat,
          createdAt: new Date("2026-10-02T00:00:00.000Z"),
        }),
        integration({ id: ID_2, kind: "http", lastHeartbeat: { nonsense: true } }),
      ],
      [],
    );
    const res = await svc.get("u1", {});
    expect(res.integrations.map((i) => i.id)).toEqual([ID_1, ID_2]);
    expect(res.integrations[0]).toMatchObject({
      lastSeenAt: "2026-10-17T10:00:00.000Z",
      heartbeat,
    });
    expect(res.integrations[1]).toMatchObject({ lastSeenAt: null, heartbeat: null });
  });

  it("rejects a blank user", async () => {
    const { svc } = service([], []);
    await expect(svc.get("  ", {})).rejects.toThrow();
  });
});
