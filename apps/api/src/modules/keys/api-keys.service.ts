import { Inject, Injectable } from "@nestjs/common";
import {
  type CreateReadKeyRequest,
  type CreateReadKeyResponse,
  INTEGRATION_NOT_FOUND_CODE,
  READ_KEY_NOT_FOUND_CODE,
  type ReadKey,
  type ReadKeyListResponse,
  type ReadKeyResponse,
  readKeyRestrictionSchema,
  readScopeSchema,
} from "@personal-api/contracts";
import { z } from "zod";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import type { IngestAuthContext, ReadAuthContext } from "../auth/auth-context";
import { type ApiKeyLookupRow, ApiKeysRepository, type ReadKeyRow } from "./api-keys.repository";
import { generateApiKey, hashApiKey, INGEST_KEY_PATTERN, READ_KEY_PATTERN } from "./key-generation";

/** last_used_at is written at most once per this interval per key. */
export const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export interface CreatedApiKey {
  id: string;
  /** The plaintext key. Returned here once and never stored. */
  key: string;
  prefix: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly repository: ApiKeysRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates an ingest key for an active integration the user owns. Rejects (and stores nothing)
   * when the integration does not exist, is revoked or belongs to another user. Only the hash and
   * the display prefix are stored; the plaintext is returned once.
   */
  async createIngestKey(userId: string, integrationId: string): Promise<CreatedApiKey> {
    assertUserScope(userId);
    if (!isUuid(integrationId)) throw integrationNotFound();
    const key = generateApiKey("ingest");
    const row = await this.repository.insertIngestKey(userId, {
      integrationId,
      prefix: key.prefix,
      hash: key.hash,
    });
    if (!row) throw integrationNotFound();
    return { id: row.id, key: key.plaintext, prefix: key.prefix };
  }

  /**
   * Sets revoked_at (clock time; a second revoke keeps the first time). Returns false when the key
   * is not the user's, or unknown.
   */
  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    assertUserScope(userId);
    if (!isUuid(keyId)) return false;
    return this.repository.revoke(userId, keyId, this.clock.now());
  }

  /**
   * Resolves a presented bearer token to an ingest AuthContext, or null for anything else:
   * unknown, malformed, revoked, revoked integration, or a pa_read_ key. Never throws for bad
   * input (a database failure still throws, so it surfaces as a 500, not as a bad key). Bumps
   * last_used_at (throttled) on success only.
   */
  async authenticateIngestKey(presented: string | undefined): Promise<IngestAuthContext | null> {
    if (typeof presented !== "string" || !INGEST_KEY_PATTERN.test(presented)) return null;
    const row = await this.repository.findByHash(hashApiKey(presented));
    if (
      row?.kind !== "ingest" ||
      row.revokedAt !== null ||
      row.integrationId === null ||
      row.integrationStatus !== "active"
    ) {
      return null;
    }

    await this.touchLastUsed(row);
    return { kind: "ingest", userId: row.userId, integrationId: row.integrationId, keyId: row.id };
  }

  /**
   * Creates a read key for the user. The plaintext is in the result and nowhere else; only its
   * hash and display prefix are stored. A restriction naming a source that is not the user's
   * stores nothing and is the same 404 as an unknown integration.
   */
  async createReadKey(
    userId: string,
    request: CreateReadKeyRequest,
  ): Promise<CreateReadKeyResponse> {
    assertUserScope(userId);
    const key = generateApiKey("read");
    const restriction = request.restriction
      ? {
          ...(request.restriction.sources && {
            sources: [...new Set(request.restriction.sources)],
          }),
          ...(request.restriction.types && { types: [...new Set(request.restriction.types)] }),
        }
      : null;
    const row = await this.repository.insertReadKey(userId, {
      name: request.name ?? null,
      prefix: key.prefix,
      hash: key.hash,
      scopes: [...request.scopes],
      restriction,
    });
    if (!row) throw integrationNotFound();
    return { readKey: toReadKey(row), key: key.plaintext };
  }

  async listReadKeys(userId: string): Promise<ReadKeyListResponse> {
    assertUserScope(userId);
    const rows = await this.repository.listReadKeys(userId);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return { readKeys: rows.map(toReadKey) };
  }

  /** Idempotent: revoking a revoked key returns it unchanged. Unknown, foreign and ingest keys are all 404. */
  async revokeReadKey(userId: string, keyId: string): Promise<ReadKeyResponse> {
    assertUserScope(userId);
    const row = isUuid(keyId)
      ? await this.repository.revokeReadKey(userId, keyId, this.clock.now())
      : null;
    if (!row) throw new AppException(404, READ_KEY_NOT_FOUND_CODE, "Key not found");
    return { readKey: toReadKey(row) };
  }

  /**
   * Resolves a presented bearer token to a read AuthContext, or null for anything else: unknown,
   * malformed, revoked, an ingest key, or a key whose stored scopes or restriction do not parse
   * (fail closed: a damaged row never grants more than it says). Like the ingest lookup it never
   * throws for bad input and bumps last_used_at (throttled) on success only.
   */
  async authenticateReadKey(presented: string | undefined): Promise<ReadAuthContext | null> {
    if (typeof presented !== "string" || !READ_KEY_PATTERN.test(presented)) return null;
    const row = await this.repository.findByHash(hashApiKey(presented));
    if (row?.kind !== "read" || row.revokedAt !== null) return null;
    const stored = parseStored(row);
    if (!stored) return null;
    await this.touchLastUsed(row);
    return {
      kind: "read",
      userId: row.userId,
      keyId: row.id,
      scopes: stored.scopes,
      restriction: stored.restriction,
    };
  }

  private async touchLastUsed(row: ApiKeyLookupRow): Promise<void> {
    const now = this.clock.now();
    if (
      row.lastUsedAt === null ||
      now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_UPDATE_INTERVAL_MS
    ) {
      await this.repository.touchLastUsed(row.userId, row.id, now, LAST_USED_UPDATE_INTERVAL_MS);
    }
  }
}

const storedScopesSchema = z.array(readScopeSchema);

/** The key's scopes and restriction, or null when either does not parse. */
function parseStored(row: {
  scopes: unknown;
  restriction: unknown;
}): { scopes: string[]; restriction: ReadAuthContext["restriction"] } | null {
  const scopes = storedScopesSchema.safeParse(row.scopes);
  if (!scopes.success) return null;
  if (row.restriction === null) return { scopes: scopes.data, restriction: null };
  const restriction = readKeyRestrictionSchema.safeParse(row.restriction);
  return restriction.success ? { scopes: scopes.data, restriction: restriction.data } : null;
}

/**
 * Explicit field list: the hash can never leak into a response by accident. A row whose stored
 * scopes or restriction do not parse is shown with no scopes; ReadKeyGuard refuses it anyway.
 */
export function toReadKey(row: ReadKeyRow): ReadKey {
  const stored = parseStored(row);
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: stored?.scopes ?? [],
    restriction: stored?.restriction ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

function integrationNotFound(): AppException {
  return new AppException(404, INTEGRATION_NOT_FOUND_CODE, "Integration not found");
}
