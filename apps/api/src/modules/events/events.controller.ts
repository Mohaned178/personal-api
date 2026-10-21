import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type {
  DeleteEventsResponse,
  DeletionFilter,
  DeletionResponse,
  GetEventResponse,
  ListEventsResponse,
} from "@personal-api/contracts";
import type { Response } from "express";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { DeletionsService } from "../deletions/deletions.service";
import { DeleteEventsDto, ListEventsQueryDto } from "./events.dto";
import { EventsService } from "./events.service";

/** Stored events. The user is the session's; neither the query nor the body names a user. */
@Controller("v1/events")
@UseGuards(SessionGuard)
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly deletions: DeletionsService,
  ) {}

  @Get()
  list(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ListEventsQueryDto,
  ): Promise<ListEventsResponse> {
    return this.events.list(auth.userId, query);
  }

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<GetEventResponse> {
    return this.events.get(auth.userId, id);
  }

  /**
   * By ids: deleted now, 200 `{deleted}`. By filter: a job, 202 `{deletion}` to poll at
   * `GET /v1/events/deletions/:id`.
   */
  @Delete()
  @HttpCode(200)
  async delete(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: DeleteEventsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeleteEventsResponse | DeletionResponse> {
    if (body.ids) return this.events.deleteByIds(auth.userId, body.ids);
    res.status(202);
    // The contract allows exactly one of ids and filter, so a body without ids has a filter.
    const filter = body.filter as DeletionFilter;
    return { deletion: await this.deletions.start(auth.userId, "events", filter) };
  }
}
