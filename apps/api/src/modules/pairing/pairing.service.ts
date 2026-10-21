import { Inject, Injectable } from "@nestjs/common";
import {
  INTEGRATION_NOT_FOUND_CODE,
  PAIRING_CODE_INVALID_CODE,
  PAIRING_CODE_TTL_MS,
  PAIRING_NOT_PAIRABLE_CODE,
  type PairingCodeResponse,
  type PairResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { toIntegration } from "../integrations/integrations.service";
import { generateApiKey } from "../keys/key-generation";
import { PairingRepository } from "./pairing.repository";
import { generatePairingCode, hashPairingCode, normalizePairingCode } from "./pairing-code";

/**
 * Pairing: the dashboard issues a one-time code for a `browser-extension` integration, and the
 * extension exchanges it for an ingest key. Both secrets (code and key) are returned once and only
 * their SHA-256 hashes are stored.
 */
@Injectable()
export class PairingService {
  constructor(
    private readonly repository: PairingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issues a code that is valid for `PAIRING_CODE_TTL_MS`, and invalidates the integration's
   * earlier unused codes. An unknown, foreign or malformed integration id is one 404; the caller's
   * own revoked or non-extension integration is a 409.
   */
  async issueCode(userId: string, integrationId: string): Promise<PairingCodeResponse> {
    assertUserScope(userId);
    if (!isUuid(integrationId)) throw integrationNotFound();
    const code = generatePairingCode();
    const expiresAt = new Date(this.clock.now().getTime() + PAIRING_CODE_TTL_MS);
    const outcome = await this.repository.issue(userId, integrationId, {
      codeHash: code.hash,
      expiresAt,
    });
    if (outcome === "not_found") throw integrationNotFound();
    if (outcome === "not_pairable") {
      throw new AppException(
        409,
        PAIRING_NOT_PAIRABLE_CODE,
        "Integration cannot be paired",
        "Only an active browser-extension integration can be paired.",
      );
    }
    return { pairingCode: code.display, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Redeems a presented code. A malformed, unknown, expired, used, superseded or revoked-integration
   * code is the same 400, so a caller learns nothing about which codes exist. The user and the
   * integration come from the code's row, never from the request.
   */
  async redeem(presented: string): Promise<PairResponse> {
    const normalized = normalizePairingCode(presented);
    if (normalized === null) throw codeInvalid();
    const key = generateApiKey();
    const paired = await this.repository.redeem(hashPairingCode(normalized), this.clock.now(), {
      prefix: key.prefix,
      hash: key.hash,
    });
    if (!paired) throw codeInvalid();
    return {
      integration: toIntegration(paired.integration),
      ingestKey: { id: paired.keyId, key: key.plaintext, prefix: key.prefix },
    };
  }
}

function integrationNotFound(): AppException {
  return new AppException(404, INTEGRATION_NOT_FOUND_CODE, "Integration not found");
}

function codeInvalid(): AppException {
  return new AppException(400, PAIRING_CODE_INVALID_CODE, "Pairing code is invalid or expired");
}
