import { createHash } from "node:crypto";
import {
  INTEGRATION_NOT_FOUND_CODE,
  PAIRING_CODE_INVALID_CODE,
  PAIRING_CODE_TTL_MS,
  PAIRING_NOT_PAIRABLE_CODE,
} from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import type { IntegrationRow } from "../integrations/integrations.repository";
import { hashApiKey, INGEST_KEY_PATTERN } from "../keys/key-generation";
import type { PairingRepository } from "./pairing.repository";
import { PairingService } from "./pairing.service";
import { generatePairingCode } from "./pairing-code";

const USER = "user-1";
const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const row: IntegrationRow = {
  id: ID,
  userId: USER,
  kind: "browser-extension",
  name: "Work Edge",
  defaultPolicy: "deny",
  status: "active",
  lastSeenAt: null,
  lastHeartbeat: null,
  createdAt: NOW,
};

function setup() {
  const repository = {
    issue: vi.fn(async (..._args: unknown[]) => "issued" as string),
    redeem: vi.fn(async (..._args: unknown[]) => ({ integration: row, keyId: ID }) as unknown),
  };
  const service = new PairingService(
    repository as unknown as PairingRepository,
    new FakeClock(NOW),
  );
  return { repository, service };
}

describe("PairingService.issueCode", () => {
  it("returns the code once with a 10-minute expiry, and hands the repository only its hash", async () => {
    const { repository, service } = setup();
    const issued = await service.issueCode(USER, ID);
    expect(issued.pairingCode).toMatch(/^([0-9A-Z]{4}-){4}[0-9A-Z]{4}$/);
    expect(issued.expiresAt).toBe(new Date(NOW.getTime() + PAIRING_CODE_TTL_MS).toISOString());
    expect(issued.expiresAt).toBe("2026-10-14T12:10:00.000Z");

    const call = repository.issue.mock.calls[0] as unknown[];
    expect(call[0]).toBe(USER);
    expect(call[1]).toBe(ID);
    expect(call[2]).toEqual({
      codeHash: createHash("sha256").update(issued.pairingCode.replaceAll("-", "")).digest("hex"),
      expiresAt: new Date(issued.expiresAt),
    });
    expect(JSON.stringify(call)).not.toContain(issued.pairingCode);
  });

  it("answers a malformed id with the same 404 as an unknown one, without a query", async () => {
    const { repository, service } = setup();
    const error = await service.issueCode(USER, "not-a-uuid").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code: INTEGRATION_NOT_FOUND_CODE });
    expect((error as AppException).getStatus()).toBe(404);
    expect(repository.issue).not.toHaveBeenCalled();
  });

  it("maps not_found to 404 integration.not_found and not_pairable to 409", async () => {
    const { repository, service } = setup();
    repository.issue.mockResolvedValueOnce("not_found");
    await expect(service.issueCode(USER, ID)).rejects.toMatchObject({
      code: INTEGRATION_NOT_FOUND_CODE,
    });
    repository.issue.mockResolvedValueOnce("not_pairable");
    const error = await service.issueCode(USER, ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: PAIRING_NOT_PAIRABLE_CODE });
    expect((error as AppException).getStatus()).toBe(409);
  });

  it("refuses a missing user before any repository call", async () => {
    const { repository, service } = setup();
    for (const bad of [undefined, null, "", "  "] as unknown as string[]) {
      await expect(service.issueCode(bad, ID)).rejects.toBeInstanceOf(MissingUserScopeError);
    }
    expect(repository.issue).not.toHaveBeenCalled();
  });
});

describe("PairingService.redeem", () => {
  it("passes the code's hash, the clock time and a new key's hash, and returns the key once", async () => {
    const { repository, service } = setup();
    const code = generatePairingCode();
    const paired = await service.redeem(code.display.toLowerCase());
    expect(paired.ingestKey.key).toMatch(INGEST_KEY_PATTERN);
    expect(paired.integration).toMatchObject({ id: ID, kind: "browser-extension" });

    const call = repository.redeem.mock.calls[0] as unknown[];
    expect(call[0]).toBe(code.hash);
    expect(call[1]).toEqual(NOW);
    expect(call[2]).toEqual({
      prefix: paired.ingestKey.prefix,
      hash: hashApiKey(paired.ingestKey.key),
    });
    expect(JSON.stringify(call)).not.toContain(paired.ingestKey.key);
  });

  it("answers a malformed code with pairing.code_invalid, without a query", async () => {
    const { repository, service } = setup();
    for (const bad of ["", "nope", "AAAA-AAAA", "x".repeat(500)]) {
      const error = await service.redeem(bad).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: PAIRING_CODE_INVALID_CODE });
      expect((error as AppException).getStatus()).toBe(400);
    }
    expect(repository.redeem).not.toHaveBeenCalled();
  });

  it("answers an unredeemable code with the same error as a malformed one", async () => {
    const { repository, service } = setup();
    repository.redeem.mockResolvedValueOnce(null);
    const unknown = await service.redeem(generatePairingCode().display).catch((e: unknown) => e);
    const malformed = await service.redeem("nope").catch((e: unknown) => e);
    expect(unknown).toMatchObject({ code: PAIRING_CODE_INVALID_CODE });
    expect((unknown as AppException).getStatus()).toBe(400);
    expect((unknown as AppException).message).toBe((malformed as AppException).message);
  });
});
