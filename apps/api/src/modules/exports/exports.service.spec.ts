import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import type { JobsService } from "../../platform/jobs/jobs.service";
import type { AccountDeletionSteps } from "../account/account.steps";
import type { ExportsRepository } from "./exports.repository";
import { ExportsService } from "./exports.service";
import type { ExportStorage } from "./exports.storage";

const USER = "user-1";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const ROW = {
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  userId: USER,
  status: "queued",
  filter: {},
  filePath: null,
  eventCount: null,
  sizeBytes: null,
  createdAt: NOW,
  finishedAt: null,
  expiresAt: null,
};

function setup(enqueue: () => Promise<string | null>) {
  const repository = {
    countRecent: vi.fn(async () => ({ active: 0, recent: 0 })),
    create: vi.fn(async () => ROW),
    fail: vi.fn(async () => 1),
  };
  const jobs = { enqueue: vi.fn(enqueue) };
  const service = new ExportsService(
    repository as unknown as ExportsRepository,
    {} as ExportStorage,
    jobs as unknown as JobsService,
    { register: vi.fn() } as unknown as AccountDeletionSteps,
    new FakeClock(NOW),
  );
  return { repository, service };
}

describe("ExportsService.create", () => {
  it("marks the export failed, scoped to the user, and rethrows when the job cannot be enqueued", async () => {
    const boom = new Error("queue down");
    const { repository, service } = setup(async () => {
      throw boom;
    });
    await expect(service.create(USER)).rejects.toBe(boom);
    expect(repository.fail).toHaveBeenCalledWith(USER, ROW.id, NOW);
  });

  it("does not insert anything while the user is at a cap", async () => {
    const { repository, service } = setup(async () => "job");
    repository.countRecent.mockResolvedValueOnce({ active: 3, recent: 3 });
    await expect(service.create(USER)).rejects.toMatchObject({ code: "export.limit_reached" });
    repository.countRecent.mockResolvedValueOnce({ active: 0, recent: 10 });
    await expect(service.create(USER)).rejects.toMatchObject({ code: "export.limit_reached" });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
