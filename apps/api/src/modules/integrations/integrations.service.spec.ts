import { INTEGRATION_NOT_FOUND_CODE } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { DeletionsService } from "../deletions/deletions.service";
import { hashApiKey, INGEST_KEY_PATTERN } from "../keys/key-generation";
import type { IntegrationRow, IntegrationsRepository } from "./integrations.repository";
import { IntegrationsService } from "./integrations.service";

const USER = "user-1";
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const row: IntegrationRow = {
  id: ID,
  userId: USER,
  kind: "http",
  name: "Laptop",
  defaultPolicy: "deny",
  status: "active",
  lastSeenAt: null,
  lastHeartbeat: null,
  createdAt: NOW,
};

function setup() {
  const repository = {
    createHttp: vi.fn(async () => ({ integration: row, keyId: ID })),
    createBrowserExtension: vi.fn(async () => ({ ...row, kind: "browser-extension" })),
    list: vi.fn(async () => [row]),
    findById: vi.fn(async () => row),
    rename: vi.fn(async () => row),
    revoke: vi.fn(async () => row),
  };
  const deletions = { start: vi.fn(async () => ({ id: ID })) };
  const service = new IntegrationsService(
    repository as unknown as IntegrationsRepository,
    new FakeClock(NOW),
    deletions as unknown as DeletionsService,
  );
  return { repository, deletions, service };
}

describe("IntegrationsService", () => {
  it("returns the plaintext key once and hands the repository only its hash and prefix", async () => {
    const { repository, service } = setup();
    const created = await service.create(USER, { kind: "http", name: "Laptop" });
    expect(created.ingestKey.key).toMatch(INGEST_KEY_PATTERN);
    const call = repository.createHttp.mock.calls[0] as unknown as unknown[];
    expect(call[2]).toEqual({
      prefix: created.ingestKey.prefix,
      hash: hashApiKey(created.ingestKey.key),
    });
    expect(JSON.stringify(call)).not.toContain(created.ingestKey.key);
    expect(Object.keys(created.integration).sort()).toEqual([
      "createdAt",
      "defaultPolicy",
      "id",
      "kind",
      "lastSeenAt",
      "name",
      "status",
    ]);
  });

  it("creates a browser-extension integration with no key at all", async () => {
    const { repository, service } = setup();
    const created = await service.createBrowserExtension(USER, {
      kind: "browser-extension",
      name: "Work Edge",
    });
    expect(repository.createBrowserExtension).toHaveBeenCalledWith(USER, { name: "Work Edge" });
    expect(repository.createHttp).not.toHaveBeenCalled();
    expect(created.integration.kind).toBe("browser-extension");
    expect(created.integration.defaultPolicy).toBe("deny");
    expect(Object.keys(created)).toEqual(["integration"]);
    expect(JSON.stringify(created)).not.toContain("pa_ing_");
  });

  it("answers a malformed id with the same 404 as an unknown id, without a query", async () => {
    const { repository, service } = setup();
    for (const call of [
      () => service.get(USER, "not-a-uuid"),
      () => service.rename(USER, "../etc", "x"),
      () => service.revoke(USER, "' or 1=1 --"),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code: INTEGRATION_NOT_FOUND_CODE });
      expect((error as AppException).getStatus()).toBe(404);
    }
    expect(repository.findById).not.toHaveBeenCalled();
    expect(repository.rename).not.toHaveBeenCalled();
    expect(repository.revoke).not.toHaveBeenCalled();
  });

  it("answers 404 when the repository finds nothing for this user", async () => {
    const { repository, service } = setup();
    repository.findById.mockResolvedValueOnce(null as never);
    await expect(service.get(USER, ID)).rejects.toMatchObject({ code: INTEGRATION_NOT_FOUND_CODE });
  });

  it("revokes with the injected clock", async () => {
    const { repository, service } = setup();
    await service.revoke(USER, ID);
    expect(repository.revoke).toHaveBeenCalledWith(USER, ID, NOW);
  });

  it("deleteData revokes first, then starts a deletion filtered to that integration", async () => {
    const { repository, deletions, service } = setup();
    const result = await service.deleteData(USER, ID);
    expect(repository.revoke).toHaveBeenCalledWith(USER, ID, NOW);
    expect(deletions.start).toHaveBeenCalledWith(USER, "integration", { source: ID });
    expect(result.integration.id).toBe(ID);
  });

  it("deleteData starts nothing for an integration that is not the user's", async () => {
    const { repository, deletions, service } = setup();
    repository.revoke.mockResolvedValueOnce(null as never);
    await expect(service.deleteData(USER, ID)).rejects.toMatchObject({
      code: INTEGRATION_NOT_FOUND_CODE,
    });
    expect(deletions.start).not.toHaveBeenCalled();
  });

  it("refuses a missing user before any repository call", async () => {
    const { repository, service } = setup();
    for (const bad of [undefined, null, "", "  "] as unknown as string[]) {
      await expect(service.list(bad)).rejects.toBeInstanceOf(MissingUserScopeError);
      await expect(service.create(bad, { kind: "http", name: "x" })).rejects.toBeInstanceOf(
        MissingUserScopeError,
      );
    }
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.createHttp).not.toHaveBeenCalled();
  });
});
