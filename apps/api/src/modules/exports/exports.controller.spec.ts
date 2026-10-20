import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableFile } from "@nestjs/common";
import { EXPORT_EVENTS_FILE, EXPORT_EXPIRED_CODE } from "@personal-api/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppException } from "../../platform/errors/problem";
import type { SessionAuthContext } from "../auth/auth-context";
import { ExportsController } from "./exports.controller";
import type { ExportsService } from "./exports.service";

const auth = { userId: "user-1" } as SessionAuthContext;
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "export-controller-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function controllerFor(path: string) {
  const service = { fileFor: vi.fn(async () => path) };
  return new ExportsController(service as unknown as ExportsService);
}

describe("ExportsController downloads", () => {
  it("answers 410 export.expired, not a 400 with the path, when the file vanishes after the check", async () => {
    const gone = join(dir, "secret-dir-name", EXPORT_EVENTS_FILE);
    const controller = controllerFor(gone);
    for (const route of [controller.download, controller.manifest]) {
      const error = await route.call(controller, auth, ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(410);
      expect((error as AppException).code).toBe(EXPORT_EXPIRED_CODE);
      expect(JSON.stringify(error)).not.toContain("secret-dir-name");
    }
  });

  it("streams an existing file", async () => {
    const file = join(dir, EXPORT_EVENTS_FILE);
    await writeFile(file, "x");
    const result = await controllerFor(file).download(auth, ID);
    expect(result).toBeInstanceOf(StreamableFile);
    result.getStream().destroy();
  });

  it("answers a stream that fails mid-way with a generic problem, never the error message", async () => {
    const file = join(dir, EXPORT_EVENTS_FILE);
    await writeFile(file, "x");
    const result = await controllerFor(file).download(auth, ID);
    result.getStream().destroy();
    const error = new Error(`EIO: i/o error, read '${file}'`);
    const sent: unknown[] = [];
    const res = {
      destroyed: false,
      headersSent: false,
      status(code: number) {
        sent.push(code);
        return res;
      },
      type(value: string) {
        sent.push(value);
        return res;
      },
      send(body: unknown) {
        sent.push(body);
        return res;
      },
    };
    result.errorHandler(error, res as never);
    expect(JSON.stringify(sent)).not.toContain(dir);
    expect(sent[0]).toBe(500);

    // Once the headers have gone out the connection is simply cut.
    const destroy = vi.fn();
    result.errorHandler(error, { destroyed: false, headersSent: true, destroy } as never);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
