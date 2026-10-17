import { Injectable } from "@nestjs/common";
import {
  type DeleteEventsResponse,
  EVENT_NOT_FOUND_CODE,
  EVENTS_DEFAULT_LIMIT,
  type GetEventResponse,
  type ListEventsQuery,
  type ListEventsResponse,
  type StoredEvent,
} from "@personal-api/contracts";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { decodeCursor, encodeCursor } from "./events.cursor";
import { type EventRow, EventsRepository } from "./events.repository";

/**
 * Stored events for one user. `userId` always comes from the session AuthContext. An unknown id,
 * someone else's id and a malformed id all give the same 404.
 */
@Injectable()
export class EventsService {
  constructor(private readonly repository: EventsRepository) {}

  async list(userId: string, query: ListEventsQuery): Promise<ListEventsResponse> {
    assertUserScope(userId);
    const limit = query.limit ?? EVENTS_DEFAULT_LIMIT;
    const rows = await this.repository.list(
      userId,
      {
        integrationId: query.source,
        type: query.type,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        domain: query.domain,
        after: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map(toStoredEvent),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
  }

  async get(userId: string, id: string): Promise<GetEventResponse> {
    assertUserScope(userId);
    const row = isUuid(id) ? await this.repository.findById(userId, id) : null;
    if (!row) throw new AppException(404, EVENT_NOT_FOUND_CODE, "Event not found");
    return { event: toStoredEvent(row) };
  }

  async deleteByIds(userId: string, ids: string[]): Promise<DeleteEventsResponse> {
    assertUserScope(userId);
    return { deleted: await this.repository.deleteByIds(userId, [...new Set(ids)]) };
  }
}

/** Explicit field list: a new column can never leak into a response by accident. */
export function toStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    integrationId: row.integrationId,
    type: row.type,
    typeVersion: row.typeVersion,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    origin: row.origin as StoredEvent["origin"],
    data: row.data as StoredEvent["data"],
    tags: row.tags,
  };
}
