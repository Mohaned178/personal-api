import { endpointScope } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { ReadAuthContext } from "../auth/auth-context";
import type { EndpointsRepository } from "./endpoints.repository";
import { EndpointsService } from "./endpoints.service";
import type { SavedQueryService } from "./saved-query.service";

const USER = "user-1";
const ENDPOINT_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const OTHER_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c";
const definition = { when: {}, window: { kind: "today" }, aggregate: "count_by_day" };

function setup(row: { enabled?: boolean } | null = {}) {
  const repository = {
    findBySlug: vi.fn(async () =>
      row ? { id: ENDPOINT_ID, definition, enabled: true, ...row } : null,
    ),
    findById: vi.fn(async () => null),
    rotateKey: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    replace: vi.fn(async () => "not_found"),
  };
  const run = vi.fn(async () => ({ kind: "count_by_day", rows: [], truncated: false }));
  const service = new EndpointsService(
    repository as unknown as EndpointsRepository,
    { execute: run } as unknown as SavedQueryService,
    new FakeClock("2026-10-14T12:00:00.000Z"),
  );
  return { repository, run, service };
}

const reader = (scopes: string[]): ReadAuthContext => ({
  kind: "read",
  userId: USER,
  keyId: "k",
  scopes,
  restriction: null,
});

async function problem(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe("EndpointsService.runBySlug", () => {
  it("runs the stored definition for the key's owner when the key has the endpoint's scope", async () => {
    const { run, repository, service } = setup();
    await service.runBySlug(reader([endpointScope(ENDPOINT_ID)]), "stats");
    expect(repository.findBySlug).toHaveBeenCalledWith(USER, "stats");
    expect(run).toHaveBeenCalledWith(USER, definition);
  });

  it.each([
    ["events:read", ["events:read", "activity:read"]],
    ["no scopes", []],
    ["another endpoint's scope", [endpointScope(OTHER_ID)]],
  ])("a key with %s is a 403 and runs nothing", async (_label, scopes) => {
    const { run, service } = setup();
    const error = await problem(service.runBySlug(reader(scopes), "stats"));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe("auth.insufficient_scope");
    expect(run).not.toHaveBeenCalled();
  });

  it("an unknown or disabled endpoint is a 404 and runs nothing", async () => {
    for (const row of [null, { enabled: false }]) {
      const { run, service } = setup(row);
      const error = await problem(service.runBySlug(reader([endpointScope(ENDPOINT_ID)]), "stats"));
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe("endpoint.not_found");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it.each(["", "Stats", "a b", "../x", "a/b", "x".repeat(41)])(
    "a malformed slug (%j) is a 404 without a query",
    async (slug) => {
      const { repository, service } = setup();
      const error = await problem(service.runBySlug(reader([endpointScope(ENDPOINT_ID)]), slug));
      expect(error.getStatus()).toBe(404);
      expect(repository.findBySlug).not.toHaveBeenCalled();
    },
  );

  it("rejects a blank owner before any query", async () => {
    const { repository, service } = setup();
    await expect(
      service.runBySlug({ ...reader([endpointScope(ENDPOINT_ID)]), userId: "" }, "stats"),
    ).rejects.toBeInstanceOf(MissingUserScopeError);
    expect(repository.findBySlug).not.toHaveBeenCalled();
  });
});

describe("EndpointsService ids", () => {
  it.each(["not-a-uuid", "", "1", "../../etc"])(
    "a malformed id (%j) is a 404 endpoint.not_found without a query",
    async (id) => {
      const { repository, service } = setup();
      for (const call of [
        service.get(USER, id),
        service.replace(USER, id, { slug: "x", enabled: true, definition: definition as never }),
        service.remove(USER, id),
        service.rotateKey(USER, id),
      ]) {
        const error = await problem(call);
        expect(error.getStatus()).toBe(404);
        expect(error.code).toBe("endpoint.not_found");
      }
      expect(repository.findById).not.toHaveBeenCalled();
      expect(repository.replace).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
      expect(repository.rotateKey).not.toHaveBeenCalled();
    },
  );
});
