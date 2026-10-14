import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import type { IngestBatchResponse } from "@personal-api/contracts";
import { CurrentAuth, type IngestAuthContext } from "../auth/auth-context";
import { IngestKeyGuard } from "../keys/ingest-key.guard";
import { IngestService } from "./ingest.service";

/**
 * The exact path of the events route. AppModule gives this path (and only this path) the larger
 * JSON body limit, so keep it in step with the decorators below (ingest.controller.spec.ts checks).
 */
export const INGEST_EVENTS_PATH = "/v1/ingest/events";

/**
 * Ingest-key routes. The user and the integration come from the key (IngestKeyGuard), never from
 * the body, query or headers. The guard runs before the body is validated, so a caller without a
 * valid key always gets 401, whatever it sent.
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
    return this.ingest.ingestBatch(auth.userId, auth.integrationId, body);
  }
}
