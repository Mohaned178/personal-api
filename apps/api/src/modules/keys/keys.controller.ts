import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import type {
  CreateReadKeyResponse,
  ReadKeyListResponse,
  ReadKeyResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { ApiKeysService } from "./api-keys.service";
import { CreateReadKeyDto } from "./keys.dto";

/**
 * Dashboard routes for read keys. The user is the session's; the body never names a user, and the
 * server sets the key kind. Ingest keys are managed through their integration, not here. The guard
 * runs before the validation pipe, so no session is always 401.
 */
@Controller("v1/keys")
@UseGuards(SessionGuard)
export class KeysController {
  constructor(private readonly keys: ApiKeysService) {}

  /** Answers with the plaintext key (shown once), so the response must not be cached. */
  @Post()
  @Header("Cache-Control", "no-store")
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: CreateReadKeyDto,
  ): Promise<CreateReadKeyResponse> {
    return this.keys.createReadKey(auth.userId, body);
  }

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<ReadKeyListResponse> {
    return this.keys.listReadKeys(auth.userId);
  }

  /** Not DELETE: a revoked key stays listed, with its revocation time. */
  @Post(":id/revoke")
  @HttpCode(200)
  revoke(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<ReadKeyResponse> {
    return this.keys.revokeReadKey(auth.userId, id);
  }
}
