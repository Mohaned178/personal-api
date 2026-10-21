import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import type { FocusRepository } from "./focus.repository";
import { FocusService } from "./focus.service";

const USER = "user-1";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

function setup() {
  const repository = {
    current: vi.fn(async () => null),
    start: vi.fn(async (_u: string, patterns: string[], endsAt: Date) => ({
      id: ID,
      patterns,
      endsAt: endsAt.toISOString(),
    })),
    end: vi.fn(async () => undefined),
  };
  const service = new FocusService(repository as unknown as FocusRepository, new FakeClock(NOW));
  return { repository, service };
}

describe("FocusService", () => {
  it("ends a session at the server clock plus the minutes, never a client time", async () => {
    const { repository, service } = setup();
    const res = await service.start(USER, { patterns: ["x.com"], minutes: 45 });
    expect(res.session?.endsAt).toBe("2026-10-21T12:45:00.000Z");
    expect(repository.start).toHaveBeenCalledWith(
      USER,
      ["x.com"],
      new Date("2026-10-21T12:45:00.000Z"),
      NOW,
    );
  });

  it("asks for the session as of the server clock", async () => {
    const { repository, service } = setup();
    await service.running(USER);
    expect(repository.current).toHaveBeenCalledWith(USER, NOW);
  });

  it("refuses a missing user before the repository is used", async () => {
    const { repository, service } = setup();
    for (const call of [
      service.running(""),
      service.start("  ", { patterns: ["x.com"], minutes: 5 }),
      service.end(""),
    ]) {
      await expect(call).rejects.toBeInstanceOf(MissingUserScopeError);
    }
    expect(repository.current).not.toHaveBeenCalled();
    expect(repository.start).not.toHaveBeenCalled();
    expect(repository.end).not.toHaveBeenCalled();
  });
});
