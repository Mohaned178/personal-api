import { Body, Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from "@nestjs/common";
import type {
  DeleteEventsResponse,
  GetEventResponse,
  ListEventsResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { DeleteEventsDto, ListEventsQueryDto } from "./events.dto";
import { EventsService } from "./events.service";

/**
 * Dashboard routes for stored events. The user is the session's; neither the query nor the body
 * names a user. The read-key variant of `GET /v1/events` comes with M5.
 */
@Controller("v1/events")
@UseGuards(SessionGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

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

  @Delete()
  @HttpCode(200)
  delete(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: DeleteEventsDto,
  ): Promise<DeleteEventsResponse> {
    return this.events.deleteByIds(auth.userId, body.ids);
  }
}
