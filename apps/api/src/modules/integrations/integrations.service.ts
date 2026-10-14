import { Inject, Injectable } from "@nestjs/common";
import {
  type CreateIntegrationRequest,
  type CreateIntegrationResponse,
  INTEGRATION_NOT_FOUND_CODE,
  type Integration,
  type IntegrationListResponse,
  type IntegrationResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { generateApiKey } from "../keys/key-generation";
import { type IntegrationRow, IntegrationsRepository } from "./integrations.repository";

/**
 * Integrations (sources) for one user. `userId` always comes from the session AuthContext. An
 * unknown id, someone else's id and a malformed id all give the same 404, so the API never
 * confirms that another user's integration exists.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly repository: IntegrationsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates a deny-by-default `http` integration with its ingest key. The plaintext key is in the
   * result and nowhere else: only its SHA-256 hash and display prefix are stored.
   */
  async create(
    userId: string,
    request: CreateIntegrationRequest,
  ): Promise<CreateIntegrationResponse> {
    assertUserScope(userId);
    const key = generateApiKey("ingest");
    const { integration, keyId } = await this.repository.createHttp(
      userId,
      { name: request.name },
      { prefix: key.prefix, hash: key.hash },
    );
    return {
      integration: toIntegration(integration),
      ingestKey: { id: keyId, key: key.plaintext, prefix: key.prefix },
    };
  }

  async list(userId: string): Promise<IntegrationListResponse> {
    assertUserScope(userId);
    const rows = await this.repository.list(userId);
    return { integrations: rows.map(toIntegration) };
  }

  async get(userId: string, id: string): Promise<IntegrationResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.findById(userId, id) : null;
    return { integration: toIntegration(found(row)) };
  }

  async rename(userId: string, id: string, name: string): Promise<IntegrationResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.rename(userId, id, name) : null;
    return { integration: toIntegration(found(row)) };
  }

  /** Idempotent: revoking a revoked integration returns it unchanged. */
  async revoke(userId: string, id: string): Promise<IntegrationResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.revoke(userId, id, this.clock.now()) : null;
    return { integration: toIntegration(found(row)) };
  }
}

function found(row: IntegrationRow | null): IntegrationRow {
  if (!row) throw new AppException(404, INTEGRATION_NOT_FOUND_CODE, "Integration not found");
  return row;
}

/** Explicit field list: a new column (or a key hash) can never leak into a response by accident. */
function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    kind: row.kind as Integration["kind"],
    name: row.name,
    defaultPolicy: row.defaultPolicy as Integration["defaultPolicy"],
    status: row.status as Integration["status"],
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
