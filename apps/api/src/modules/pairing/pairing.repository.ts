import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { apiKeys, integrations, pairingCodes } from "../../platform/db/schema";
import { scopeCondition, tenantScope } from "../../platform/db/tenant-scope";
import type { IntegrationRow } from "../integrations/integrations.repository";

export type IssueOutcome = "issued" | "not_found" | "not_pairable";

export interface NewPairingCode {
  /** SHA-256 of the normalized code. The plaintext never reaches this layer. */
  codeHash: string;
  expiresAt: Date;
}

export interface NewPairedIngestKey {
  prefix: string;
  /** SHA-256 of the plaintext key. The plaintext never reaches this layer. */
  hash: string;
}

/**
 * Every method takes `userId` as its FIRST argument and goes through `tenantScope`, except
 * `redeem`: it is the one deliberately unscoped entry point, because the caller of `POST /v1/pair`
 * has no session. It finds who owns the code from the code's own row (looked up by hash), and
 * everything after that lookup is scoped to that row's `userId`. Keep helpers out of the class (or
 * prefix them with `_`): the scoping spec walks the prototype.
 *
 * Lock order, shared with IntegrationsRepository.revoke and ApiKeysRepository.insertIngestKey: the
 * integration row first, then the pairing code row, then the key.
 */
@Injectable()
export class PairingRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Stores a new code for one of the user's active `browser-extension` integrations and deletes
   * the integration's older unused codes, in ONE transaction. The integration row is locked FOR
   * UPDATE, so two concurrent issues run one after the other (each deletes the other's code) and
   * a concurrent revoke either waits for this or makes this answer `not_pairable`. Unknown and
   * foreign integrations are both `not_found`.
   */
  async issue(userId: string, integrationId: string, code: NewPairingCode): Promise<IssueOutcome> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const [integration] = await tx
        .select({ status: integrations.status, kind: integrations.kind })
        .from(integrations)
        .where(scopeCondition(integrations, userId, eq(integrations.id, integrationId)))
        .for("update");
      if (!integration) return "not_found";
      if (integration.status !== "active" || integration.kind !== "browser-extension") {
        return "not_pairable";
      }
      const scope = tenantScope(tx, userId);
      await scope.delete(
        pairingCodes,
        and(eq(pairingCodes.integrationId, integrationId), isNull(pairingCodes.usedAt)),
      );
      await scope.insert(pairingCodes, {
        integrationId,
        codeHash: code.codeHash,
        expiresAt: code.expiresAt,
      });
      return "issued";
    });
  }

  /**
   * Exchanges a code for a new ingest key, or returns null (and changes nothing) when the code is
   * unknown, expired, used, superseded, or its integration is revoked or no longer a
   * `browser-extension`. All of those look the same to the caller.
   *
   * ONE transaction. The code row is read only to learn which integration to lock (the integration
   * row goes first, FOR SHARE, so a concurrent revoke either waits for this and then revokes the
   * new key too, or commits first and makes this return null). The decision itself is the single
   * conditional UPDATE: `used_at IS NULL AND expires_at > now`, so of two concurrent redeems
   * exactly one gets a row back. `now` is the injected clock (a code is valid strictly before
   * `expires_at`).
   */
  async redeem(
    codeHash: string,
    now: Date,
    key: NewPairedIngestKey,
  ): Promise<{ integration: IntegrationRow; keyId: string } | null> {
    return this.db.transaction(async (tx) => {
      const [code] = await tx
        .select({ userId: pairingCodes.userId, integrationId: pairingCodes.integrationId })
        .from(pairingCodes)
        .where(eq(pairingCodes.codeHash, codeHash))
        .limit(1);
      if (!code) return null;

      const [integration] = await tx
        .select()
        .from(integrations)
        .where(
          scopeCondition(
            integrations,
            code.userId,
            and(
              eq(integrations.id, code.integrationId),
              eq(integrations.status, "active"),
              eq(integrations.kind, "browser-extension"),
            ),
          ),
        )
        .for("share");
      if (!integration) return null;

      const scope = tenantScope(tx, code.userId);
      const [used] = await scope.update(
        pairingCodes,
        { usedAt: now },
        and(
          eq(pairingCodes.codeHash, codeHash),
          isNull(pairingCodes.usedAt),
          gt(pairingCodes.expiresAt, now),
        ),
      );
      if (!used) return null;

      const [stored] = await scope.insert(apiKeys, {
        kind: "ingest",
        integrationId: integration.id,
        prefix: key.prefix,
        hash: key.hash,
      });
      if (!stored) throw new Error("api key insert returned no row");
      return { integration, keyId: stored.id };
    });
  }
}
