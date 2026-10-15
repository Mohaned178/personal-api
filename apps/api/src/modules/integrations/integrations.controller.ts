import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  CreateIntegrationResponse,
  IntegrationListResponse,
  IntegrationResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { CreateIntegrationDto, RenameIntegrationDto } from "./integrations.dto";
import { IntegrationsService } from "./integrations.service";

/**
 * Dashboard routes for sources. The user is the session's; the body never names a user or an
 * integration owner. The guard runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/integrations")
@UseGuards(SessionGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * An `http` integration answers with its ingest key (shown once), so the response must not be
   * cached. A `browser-extension` one answers with the integration only: its key is issued when
   * the extension redeems a pairing code.
   */
  @Post()
  @Header("Cache-Control", "no-store")
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: CreateIntegrationDto,
  ): Promise<CreateIntegrationResponse | IntegrationResponse> {
    return body.kind === "http"
      ? this.integrations.create(auth.userId, body)
      : this.integrations.createBrowserExtension(auth.userId, body);
  }

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<IntegrationListResponse> {
    return this.integrations.list(auth.userId);
  }

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<IntegrationResponse> {
    return this.integrations.get(auth.userId, id);
  }

  @Patch(":id")
  rename(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: RenameIntegrationDto,
  ): Promise<IntegrationResponse> {
    return this.integrations.rename(auth.userId, id, body.name);
  }

  /** Not DELETE: there is no hard delete until M6-03. Revokes the integration and its keys. */
  @Post(":id/revoke")
  @HttpCode(200)
  revoke(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<IntegrationResponse> {
    return this.integrations.revoke(auth.userId, id);
  }
}
