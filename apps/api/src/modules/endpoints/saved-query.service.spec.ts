import { SAVED_QUERY_INVALID_CODE, SAVED_QUERY_TIMEOUT_CODE } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { SettingsService } from "../settings/settings.service";
import type { CompiledSavedQuery } from "./saved-query.compiler";
import type { SavedQueryRepository } from "./saved-query.repository";
import { SavedQueryService } from "./saved-query.service";

const definition = { when: {}, window: { kind: "today" }, fields: ["type"] };

function setup(run: SavedQueryRepository["run"]) {
  const repository = { run: vi.fn(run) } as unknown as SavedQueryRepository;
  const settings = {
    get: vi.fn(async () => ({ timeZone: "Asia/Tokyo" })),
  } as unknown as SettingsService;
  const service = new SavedQueryService(
    repository,
    settings,
    new FakeClock("2026-10-14T12:00:00Z"),
  );
  return { service, repository, settings };
}

async function problem(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe("SavedQueryService", () => {
  it("compiles with the user's time zone, then runs it for the same user", async () => {
    const { service, repository, settings } = setup(async () => ({
      kind: "events",
      rows: [],
      truncated: false,
    }));
    await service.execute("user-1", definition);
    expect(settings.get).toHaveBeenCalledWith("user-1");
    const [userId, compiled] = vi.mocked(repository.run).mock.calls[0] as [
      string,
      CompiledSavedQuery,
    ];
    expect(userId).toBe("user-1");
    expect(compiled.kind).toBe("events");
  });

  it("rejects a missing user before reading anything", async () => {
    const { service, settings } = setup(async () => ({
      kind: "events",
      rows: [],
      truncated: false,
    }));
    await expect(service.execute("", definition)).rejects.toBeInstanceOf(MissingUserScopeError);
    expect(settings.get).not.toHaveBeenCalled();
  });

  it("answers 409 saved_query.definition_invalid for a stored definition that no longer parses, without running it", async () => {
    const { service, repository } = setup(async () => ({
      kind: "events",
      rows: [],
      truncated: false,
    }));
    const secret = "secret-domain.example";
    const error = await problem(
      service.execute("user-1", {
        ...definition,
        when: { all: [{ field: "data.domain", op: "regex", value: secret }] },
      }),
    );
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(SAVED_QUERY_INVALID_CODE);
    expect(JSON.stringify([error.message, error.detail, error.extensions])).not.toContain(secret);
    expect(repository.run).not.toHaveBeenCalled();
  });

  it("answers 504 saved_query.timeout when Postgres cancels the statement, even when the ORM wrapped the error", async () => {
    for (const thrown of [
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      Object.assign(new Error("Failed query"), { cause: { code: "57014" } }),
    ]) {
      const { service } = setup(async () => {
        throw thrown;
      });
      const error = await problem(service.execute("user-1", definition));
      expect(error.getStatus()).toBe(504);
      expect(error.code).toBe(SAVED_QUERY_TIMEOUT_CODE);
    }
  });

  it("lets any other failure through unchanged", async () => {
    const boom = new Error("connection lost");
    const { service } = setup(async () => {
      throw boom;
    });
    await expect(service.execute("user-1", definition)).rejects.toBe(boom);
  });
});
