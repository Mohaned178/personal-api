import { Controller, Get, Header, Param, UseGuards } from "@nestjs/common";
import type { SavedQueryResult } from "@personal-api/contracts";
import { CurrentAuth, type ReadAuthContext } from "../auth/auth-context";
import { ReadKeyGuard, RequireEndpointScope } from "../keys/read-key.guard";
import { EndpointsService } from "./endpoints.service";

/**
 * `GET /v1/me/:slug`: runs a user-defined endpoint. Read key only (never a session cookie): the
 * key must carry `endpoint:<id>` of the endpoint the slug names, which the service checks.
 */
@Controller("v1/me")
@UseGuards(ReadKeyGuard)
@RequireEndpointScope()
export class MeController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get(":slug")
  @Header("Cache-Control", "no-store")
  run(
    @CurrentAuth("read") auth: ReadAuthContext,
    @Param("slug") slug: string,
  ): Promise<SavedQueryResult> {
    return this.endpoints.runBySlug(auth, slug);
  }
}
