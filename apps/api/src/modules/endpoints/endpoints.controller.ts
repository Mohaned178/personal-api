import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import type {
  EndpointKeyResponse,
  EndpointListResponse,
  EndpointResponse,
  PreviewEndpointResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { EndpointInputDto, PreviewEndpointDto } from "./endpoints.dto";
import { EndpointsService } from "./endpoints.service";

/**
 * Dashboard routes for endpoints. The user is the session's; the body never names a user, an id or
 * a key. The guard runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/endpoints")
@UseGuards(SessionGuard)
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<EndpointListResponse> {
    return this.endpoints.list(auth.userId);
  }

  /** Dry run of an unsaved definition. Stores nothing. */
  @Post("preview")
  @HttpCode(200)
  preview(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: PreviewEndpointDto,
  ): Promise<PreviewEndpointResponse> {
    return this.endpoints.preview(auth.userId, body);
  }

  /** Answers with the plaintext key (shown once), so the response must not be cached. */
  @Post()
  @Header("Cache-Control", "no-store")
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: EndpointInputDto,
  ): Promise<EndpointKeyResponse> {
    return this.endpoints.create(auth.userId, body);
  }

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<EndpointResponse> {
    return this.endpoints.get(auth.userId, id);
  }

  /** Replaces the whole endpoint (slug, enabled, definition). */
  @Put(":id")
  replace(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
    @Body() body: EndpointInputDto,
  ): Promise<EndpointResponse> {
    return this.endpoints.replace(auth.userId, id, body);
  }

  @Delete(":id")
  remove(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<EndpointResponse> {
    return this.endpoints.remove(auth.userId, id);
  }

  /** Revokes the endpoint's keys and answers with a new one (shown once). */
  @Post(":id/rotate-key")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  rotateKey(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<EndpointKeyResponse> {
    return this.endpoints.rotateKey(auth.userId, id);
  }
}
