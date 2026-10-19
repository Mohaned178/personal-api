import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { ReadinessRegistry } from "../health/readiness";
import { checkJobs } from "./jobs.readiness";
import { JobRegistry } from "./jobs.registry";
import { JobsService } from "./jobs.service";
import { NOOP_QUEUE } from "./jobs.tokens";

function fakeBoss(overrides: Record<string, unknown> = {}) {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue("worker-id"),
    send: vi.fn().mockResolvedValue("job-id"),
    schedule: vi.fn().mockResolvedValue(undefined),
    getQueue: vi.fn().mockResolvedValue({ name: NOOP_QUEUE }),
    ...overrides,
  };
}

function build(work: boolean, boss = fakeBoss()) {
  const registry = new JobRegistry();
  const readiness = new ReadinessRegistry();
  const service = new JobsService(boss as unknown as PgBoss, { work }, registry, readiness);
  return { boss, registry, readiness, service };
}

describe("JobRegistry", () => {
  it("lists registrations and rejects a duplicate queue", () => {
    const registry = new JobRegistry();
    registry.register({ queue: "a", handler: async () => {} });
    registry.register({ queue: "b", handler: async () => {} });
    expect(registry.list().map((r) => r.queue)).toEqual(["a", "b"]);
    expect(() => registry.register({ queue: "a", handler: async () => {} })).toThrow(
      "already registered",
    );
  });
});

describe("JobsService", () => {
  it("in worker mode creates each queue explicitly and subscribes its handler", async () => {
    const { boss, registry, service } = build(true);
    const handler = vi.fn().mockResolvedValue(undefined);
    registry.register({ queue: "q1", handler, queueOptions: { retryLimit: 2 } });
    service.onModuleInit();
    await service.onApplicationBootstrap();

    expect(boss.start).toHaveBeenCalledOnce();
    expect(boss.createQueue).toHaveBeenCalledWith("q1", { retryLimit: 2 });
    expect(boss.work).toHaveBeenCalledOnce();

    const workHandler = boss.work.mock.calls[0]?.[1] as (jobs: unknown[]) => Promise<void>;
    await workHandler([{ id: "j1", name: "q1", data: { x: 1 } }]);
    expect(handler).toHaveBeenCalledWith({ id: "j1", data: { x: 1 } });
  });

  it("in enqueue-only mode creates queues but never subscribes handlers", async () => {
    const { boss, registry, service } = build(false);
    registry.register({ queue: "q1", handler: async () => {} });
    service.onModuleInit();
    await service.onApplicationBootstrap();
    expect(boss.createQueue).toHaveBeenCalledWith("q1", undefined);
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("in worker mode schedules a registration's cron after creating its queue", async () => {
    const { boss, registry, service } = build(true);
    registry.register({ queue: "q1", handler: async () => {}, schedule: "0 * * * *" });
    registry.register({ queue: "q2", handler: async () => {} });
    service.onModuleInit();
    await service.onApplicationBootstrap();
    expect(boss.schedule).toHaveBeenCalledOnce();
    expect(boss.schedule).toHaveBeenCalledWith("q1", "0 * * * *", {});
  });

  it("in enqueue-only mode never schedules (the worker owns the cron)", async () => {
    const { boss, registry, service } = build(false);
    registry.register({ queue: "q1", handler: async () => {}, schedule: "0 * * * *" });
    service.onModuleInit();
    await service.onApplicationBootstrap();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("a failing handler propagates so pg-boss can retry the job", async () => {
    const { boss, registry, service } = build(true);
    registry.register({
      queue: "q1",
      handler: async () => {
        throw new Error("boom");
      },
    });
    service.onModuleInit();
    await service.onApplicationBootstrap();
    const workHandler = boss.work.mock.calls[0]?.[1] as (jobs: unknown[]) => Promise<void>;
    await expect(workHandler([{ id: "j1", data: {} }])).rejects.toThrow("boom");
  });

  it("enqueue forwards to pg-boss send", async () => {
    const { boss, service } = build(false);
    await expect(service.enqueue("q1", { a: 1 })).resolves.toBe("job-id");
    expect(boss.send).toHaveBeenCalledWith("q1", { a: 1 }, undefined);
  });

  it("stops pg-boss gracefully on destroy", async () => {
    const { boss, service } = build(true);
    service.onModuleInit();
    await service.onApplicationBootstrap();
    await service.onModuleDestroy();
    expect(boss.stop).toHaveBeenCalledWith(expect.objectContaining({ graceful: true }));
  });
});

describe("queue readiness", () => {
  it("is down before start and up after start, then down after destroy", async () => {
    const { readiness, service } = build(false);
    service.onModuleInit();
    expect(await readiness.run()).toEqual({ ready: false, checks: { queue: "down" } });
    await service.onApplicationBootstrap();
    expect(await readiness.run()).toEqual({ ready: true, checks: { queue: "up" } });
    await service.onModuleDestroy();
    expect((await readiness.run()).checks.queue).toBe("down");
  });

  it("is down when pg-boss errors, without exposing the error", async () => {
    const boss = fakeBoss({
      getQueue: vi.fn().mockRejectedValue(new Error("postgres://user:secret@host/db")),
    });
    const { readiness, service } = build(false, boss);
    service.onModuleInit();
    await service.onApplicationBootstrap();
    const result = await readiness.run();
    expect(result).toEqual({ ready: false, checks: { queue: "down" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("checkJobs rejects when the queue is missing or the call hangs", async () => {
    await expect(checkJobs({ getQueue: async () => null }, () => true)).rejects.toThrow();
    await expect(
      checkJobs({ getQueue: () => new Promise(() => {}) }, () => true, 20),
    ).rejects.toThrow("timeout");
  });
});
