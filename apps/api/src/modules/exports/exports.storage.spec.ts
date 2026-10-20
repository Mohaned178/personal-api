import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config/config";

const mkdirSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mkdirSpy.mockImplementation(actual.mkdir);
  return { ...actual, mkdir: mkdirSpy };
});

import { ExportStorage } from "./exports.storage";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "export-storage-"));
  mkdirSpy.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ExportStorage", () => {
  it("creates an export directory that only its owner can use", async () => {
    const storage = new ExportStorage({ EXPORT_DIR: root } as AppConfig);
    const dir = await storage.prepare(ID);
    expect(mkdirSpy).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
  });
});
