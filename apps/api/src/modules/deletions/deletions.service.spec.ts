import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import type { JobsService } from "../../platform/jobs/jobs.service";
import type { DeletionsRepository } from "./deletions.repository";
import { DeletionsService } from "./deletions.service";

const USER = "user-1";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const ROW = {
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  userId: USER,
  kind: "events",
  status: "queued",
  filter: { domain: "example.com" },
  total: null,
  deleted: 0,
  createdAt: NOW,
  finishedAt: null,
};

function setup(enqueue: () => Promise<string | null>) {
  const repository = {
    create: vi.fn(async () => ROW),
    finish: vi.fn(async () => undefined),
  };
  const jobs = { enqueue: vi.fn(enqueue) };
  const service = new DeletionsService(
    repository as unknown as DeletionsRepository,
    jobs as unknown as JobsService,
    new FakeClock(NOW),
  );
  return { repository, jobs, service };
}

describe("DeletionsService.start", () => {
  it("enqueues the job and leaves the row queued", async () => {
    const { repository, jobs, service } = setup(async () => "job");
    const deletion = await service.start(USER, "events", { domain: "example.com" });
    expect(deletion).toMatchObject({ id: ROW.id, status: "queued" });
    expect(jobs.enqueue).toHaveBeenCalledOnce();
    expect(repository.finish).not.toHaveBeenCalled();
  });

  it("marks the deletion failed, scoped to the user, and rethrows when the job cannot be enqueued", async () => {
    const boom = new Error("queue down");
    const { repository, service } = setup(async () => {
      throw boom;
    });
    await expect(service.start(USER, "events", { domain: "example.com" })).rejects.toBe(boom);
    expect(repository.finish).toHaveBeenCalledWith(USER, ROW.id, "failed", NOW);
  });

  it("still rethrows the enqueue error when marking the row failed fails too", async () => {
    const boom = new Error("queue down");
    const { repository, service } = setup(async () => {
      throw boom;
    });
    repository.finish.mockRejectedValueOnce(new Error("db down"));
    await expect(service.start(USER, "events", { domain: "example.com" })).rejects.toBe(boom);
  });
});
