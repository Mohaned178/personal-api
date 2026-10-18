import { Body, Controller, Get, Headers, HttpCode, Post, Res, UseGuards } from "@nestjs/common";
import type { IngestBatchResponse, IngestConfigResponse } from "@personal-api/contracts";
import type { Response } from "express";
import { CurrentAuth, type IngestAuthContext } from "../auth/auth-context";
import { IngestKeyGuard } from "../keys/ingest-key.guard";
import { ifNoneMatchHits } from "./etag";
import { HeartbeatDto } from "./heartbeat.dto";
import { IngestService } from "./ingest.service";

/**
 * The exact path of the events route. AppModule gives this path (and only this path) the larger
 * JSON body limit, so keep it in step with the decorators below (ingest.controller.spec.ts checks).
 */
export const INGEST_EVENTS_PATH = "/v1/ingest/events";

/**
 * Ingest-key routes. The user and the integration come from the key (IngestKeyGuard), never from
 * the body, query or headers. The guard runs before the body is validated, so a caller without a
 * valid key gets 401 for any body that parses, never a validation error. Body parsing is
 * middleware (BodyParserModule) and runs before every guard, so an oversized body (413
 * `http.payload_too_large`) or malformed JSON (400) is refused before the key is checked.
 */
@Controller("v1/ingest")
@UseGuards(IngestKeyGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /**
   * A batch of up to 100 events (256 KB). 200 with one result per event, in request order, even
   * when every event was rejected. The body is typed `unknown` on purpose: the service validates
   * it, so a bad batch is `ingest.batch_invalid`, not the global pipe's `request.invalid`.
   */
  @Post("events")
  @HttpCode(200)
  events(
    @CurrentAuth("ingest") auth: IngestAuthContext,
    @Body() body: unknown,
  ): Promise<IngestBatchResponse> {
    return this.ingest.ingestBatch(auth.userId, auth.integrationId, auth.keyId, body);
  }

  /**
   * The user's collect rules for the extension, with a strong ETag. `If-None-Match` that matches
   * answers 304 with no body. `private, no-cache`: a cache may keep it but must revalidate, and
   * the answer depends on the key, so it is never shared.
   */
  @Get("config")
  async config(
    @CurrentAuth("ingest") auth: IngestAuthContext,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestConfigResponse | undefined> {
    const { config, etag } = await this.ingest.getConfig(auth.userId, auth.integrationId);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (ifNoneMatchHits(ifNoneMatch, etag)) {
      res.status(304);
      return undefined;
    }
    return config;
  }

  /**
   * Queue health from the client. The body is validated by the global pipe (after the guard), so
   * a bad body is 400 `request.invalid`. 204: nothing to return.
   */
  @Post("heartbeat")
  @HttpCode(204)
  async heartbeat(
    @CurrentAuth("ingest") auth: IngestAuthContext,
    @Body() body: HeartbeatDto,
  ): Promise<void> {
    await this.ingest.recordHeartbeat(auth.userId, auth.integrationId, body);
  }
}
