import { Body, Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from "@nestjs/common";
import type {
  DeleteEventsResponse,
  GetEventResponse,
  ListEventsResponse,
} from "@personal-api/contracts";
import {
  CurrentAuth,
  CurrentReader,
  type ReaderAuthContext,
  type SessionAuthContext,
} from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { RequireReadScope } from "../keys/read-key.guard";
import { SessionOrReadKeyGuard } from "../keys/session-or-read-key.guard";
import { DeleteEventsDto, ListEventsQueryDto } from "./events.dto";
import { EventsService } from "./events.service";

/**
 * Stored events. The user is the session's or the read key's; neither the query nor the body names
 * a user. The list is open to a read key with `events:read`; getting one and deleting are
 * dashboard-only.
 */
@Controller("v1/events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @UseGuards(SessionOrReadKeyGuard)
  @RequireReadScope("events:read")
  list(
    @CurrentReader() auth: ReaderAuthContext,
    @Query() query: ListEventsQueryDto,
  ): Promise<ListEventsResponse> {
    return this.events.list(
      auth.userId,
      query,
      auth.kind === "read"
        ? { restriction: auth.restriction, withTrace: false }
        : { restriction: null, withTrace: true },
    );
  }

  @Get(":id")
  @UseGuards(SessionGuard)
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<GetEventResponse> {
    return this.events.get(auth.userId, id);
  }

  @Delete()
  @UseGuards(SessionGuard)
  @HttpCode(200)
  delete(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: DeleteEventsDto,
  ): Promise<DeleteEventsResponse> {
    return this.events.deleteByIds(auth.userId, body.ids);
  }
}
