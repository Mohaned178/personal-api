import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import type { EventsRepository } from "../events/events.repository";
import type { ExportsRepository } from "./exports.repository";
import type { ExportStorage } from "./exports.storage";

const fsSpies = vi.hoisted(() => ({ createWriteStream: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsSpies.createWriteStream.mockImplementation(actual.createWriteStream);
  return { ...actual, createWriteStream: fsSpies.createWriteStream };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsSpies.writeFile.mockImplementation(actual.writeFile);
  return { ...actual, writeFile: fsSpies.writeFile };
});

import { ExportsRunService } from "./exports-run.service";

const USER = "user-1";
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const NOW = new Date("2026-10-14T12:00:00.000Z");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "export-run-"));
  fsSpies.createWriteStream.mockClear();
  fsSpies.writeFile.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(completeRows: number) {
  const repository = {
    markRunning: vi.fn(async () => ({ filter: {} })),
    complete: vi.fn(async () => completeRows),
    fail: vi.fn(async () => 1),
  };
  const eventsRepository = { list: vi.fn(async () => []) };
  const storage = {
    prepare: vi.fn(async () => {
      await mkdir(join(dir, ID), { recursive: true });
      return join(dir, ID);
    }),
    file: vi.fn((_id: string, name: string) => join(dir, ID, name)),
    publish: vi.fn(async (from: string, to: string) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    }),
    remove: vi.fn(async () => undefined),
  };
  const service = new ExportsRunService(
    repository as unknown as ExportsRepository,
    eventsRepository as unknown as EventsRepository,
    storage as unknown as ExportStorage,
    new FakeClock(NOW),
  );
  return { repository, storage, service };
}

describe("ExportsRunService", () => {
  it("writes its temporary files readable only by their owner", async () => {
    const { service } = setup(1);
    await service.run(USER, ID);
    expect(fsSpies.createWriteStream).toHaveBeenCalledWith(
      expect.stringMatching(/events\.ndjson\.gz\.tmp$/),
      { mode: 0o600 },
    );
    expect(fsSpies.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/manifest\.json\.tmp$/),
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it("keeps its files when the export row was updated", async () => {
    const { service, storage } = setup(1);
    await service.run(USER, ID);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("removes its files at once when the row is gone (account deleted mid-run)", async () => {
    const { service, storage, repository } = setup(0);
    await expect(service.run(USER, ID)).resolves.toBe(0);
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledWith(ID);
    expect(repository.fail).not.toHaveBeenCalled();
  });
});
