import { Inject, Injectable } from "@nestjs/common";
import {
  ENDPOINT_LIMIT_REACHED_CODE,
  ENDPOINT_NOT_FOUND_CODE,
  ENDPOINT_SLUG_TAKEN_CODE,
  type Endpoint,
  type EndpointDefinitionInput,
  type EndpointKeyResponse,
  type EndpointListResponse,
  type EndpointResponse,
  endpointSchema,
  endpointScope,
  endpointSlugSchema,
  type PreviewEndpointRequest,
  type PreviewEndpointResponse,
  type ReplaceEndpointRequest,
  type SavedQueryResult,
} from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import type { ReadAuthContext } from "../auth/auth-context";
import { generateApiKey } from "../keys/key-generation";
import {
  type EndpointRefusal,
  type EndpointRow,
  EndpointsRepository,
} from "./endpoints.repository";
import { SavedQueryService } from "./saved-query.service";

/**
 * User-defined endpoints. `userId` always comes from an AuthContext (the session for management,
 * the read key for `/v1/me/:slug`), never from a request. An unknown, foreign or malformed id gives
 * the same 404, so the API never confirms that another user's endpoint exists. Definitions are
 * validated by the request DTO (the contracts' schema) before they get here.
 */
@Injectable()
export class EndpointsService {
  constructor(
    private readonly repository: EndpointsRepository,
    private readonly savedQueries: SavedQueryService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<EndpointListResponse> {
    assertUserScope(userId);
    return { endpoints: (await this.repository.list(userId)).map(toEndpoint) };
  }

  async get(userId: string, id: string): Promise<EndpointResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.findById(userId, id) : null;
    if (!row) throw notFound();
    return { endpoint: toEndpoint(row) };
  }

  /** Creates the endpoint and its first key. The plaintext key is in the result and nowhere else. */
  async create(userId: string, input: EndpointDefinitionInput): Promise<EndpointKeyResponse> {
    assertUserScope(userId);
    const key = generateApiKey("read");
    const result = await this.repository.create(
      userId,
      input,
      { prefix: key.prefix, hash: key.hash },
      this.clock.now(),
    );
    if (typeof result === "string") throw refused(result);
    return { endpoint: toEndpoint(result), key: key.plaintext };
  }

  async replace(
    userId: string,
    id: string,
    input: ReplaceEndpointRequest,
  ): Promise<EndpointResponse> {
    assertUserScope(userId);
    if (!isUuid(id)) throw notFound();
    const result = await this.repository.replace(userId, id, input, this.clock.now());
    if (typeof result === "string") throw refused(result);
    return { endpoint: toEndpoint(result) };
  }

  async remove(userId: string, id: string): Promise<EndpointResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.remove(userId, id) : null;
    if (!row) throw notFound();
    return { endpoint: toEndpoint(row) };
  }

  /** Revokes the endpoint's keys and mints a new one. */
  async rotateKey(userId: string, id: string): Promise<EndpointKeyResponse> {
    assertUserScope(userId);
    const key = generateApiKey("read");
    const row = isUuid(id)
      ? await this.repository.rotateKey(
          userId,
          id,
          { prefix: key.prefix, hash: key.hash },
          this.clock.now(),
        )
      : null;
    if (!row) throw notFound();
    return { endpoint: toEndpoint(row), key: key.plaintext };
  }

  /** A dry run of an unsaved definition, with the same limits as the real thing. Stores nothing. */
  async preview(userId: string, request: PreviewEndpointRequest): Promise<PreviewEndpointResponse> {
    assertUserScope(userId);
    return { result: await this.savedQueries.execute(userId, request.definition) };
  }

  /**
   * `GET /v1/me/:slug`. The owner is the key's, the endpoint is the slug within that owner's, and
   * the key must carry `endpoint:<that id>`: a key for another endpoint, `events:read` and the like
   * never run it. A disabled endpoint, and one the key does not cover, look exactly like a slug that
   * does not exist (404).
   */
  async runBySlug(auth: ReadAuthContext, slug: string): Promise<SavedQueryResult> {
    assertUserScope(auth.userId);
    const row = endpointSlugSchema.safeParse(slug).success
      ? await this.repository.findBySlug(auth.userId, slug)
      : null;
    // A missing slug, a disabled endpoint and a key without this endpoint's scope are one 404, so a
    // key can never be used to find out which slugs its owner has.
    if (!row?.enabled || !auth.scopes.includes(endpointScope(row.id))) throw notFound();
    // The raw stored definition: the runner parses it again and answers 409 when it no longer fits.
    return this.savedQueries.execute(auth.userId, row.definition);
  }
}

/** Parsed again on the way out: a stored document that no longer fits is a 500, never a guess. */
function toEndpoint(row: EndpointRow): Endpoint {
  return endpointSchema.parse({
    id: row.id,
    slug: row.slug,
    enabled: row.enabled,
    definition: row.definition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function notFound(): AppException {
  return new AppException(404, ENDPOINT_NOT_FOUND_CODE, "Endpoint not found");
}

function refused(reason: EndpointRefusal): AppException {
  switch (reason) {
    case "not_found":
      return notFound();
    case "slug_taken":
      return new AppException(
        409,
        ENDPOINT_SLUG_TAKEN_CODE,
        "You already have an endpoint with this slug",
      );
    case "limit_reached":
      return new AppException(409, ENDPOINT_LIMIT_REACHED_CODE, "Endpoint limit reached");
  }
}
