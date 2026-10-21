import { Inject, Injectable } from "@nestjs/common";
import {
  type CreateIntegrationRequest,
  type CreateIntegrationResponse,
  type DeleteIntegrationDataResponse,
  INTEGRATION_NOT_FOUND_CODE,
  type Integration,
  type IntegrationListResponse,
  type IntegrationResponse,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { DeletionsService } from "../deletions/deletions.service";
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
    private readonly deletions: DeletionsService,
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
    const key = generateApiKey();
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

  /**
   * Creates a deny-by-default `browser-extension` integration. No key is created here: the
   * extension gets its ingest key (once) when it redeems a pairing code, so the response carries
   * the integration only.
   */
  async createBrowserExtension(
    userId: string,
    request: CreateIntegrationRequest,
  ): Promise<IntegrationResponse> {
    assertUserScope(userId);
    const integration = await this.repository.createBrowserExtension(userId, {
      name: request.name,
    });
    return { integration: toIntegration(integration) };
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

  /**
   * "Disconnect and delete this integration's data": revokes the integration and its keys (so
   * nothing new arrives), then starts a bulk deletion of every event it stored. The integration
   * row stays, revoked, so ingestion counters and its name remain. Its source retention policy
   * goes too: it would name a source with no data left, and the dashboard lists only active
   * sources for policies. Repeating it is safe: it starts another deletion that finds nothing.
   */
  async deleteData(userId: string, id: string): Promise<DeleteIntegrationDataResponse> {
    const { integration } = await this.revoke(userId, id);
    await this.repository.removeSourcePolicy(userId, integration.id);
    const deletion = await this.deletions.start(userId, "integration", { source: integration.id });
    return { integration, deletion };
  }
}

function found(row: IntegrationRow | null): IntegrationRow {
  if (!row) throw new AppException(404, INTEGRATION_NOT_FOUND_CODE, "Integration not found");
  return row;
}

/** Explicit field list: a new column (or a key hash) can never leak into a response by accident. */
export function toIntegration(row: IntegrationRow): Integration {
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
