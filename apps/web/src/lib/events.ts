import type {
  DeleteEventsResponse,
  ListEventsQuery,
  ListEventsResponse,
  StoredEvent,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/events. Same-origin with the session cookie. Failures throw a generic
 * error (no body, URL or filter value in the message), and nothing here logs.
 */
export type { StoredEvent };

export type EventFilters = Pick<ListEventsQuery, "source" | "type" | "from" | "to" | "domain">;

export async function listEvents(
  filters: EventFilters,
  cursor: string | undefined,
): Promise<ListEventsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  const res = await fetch(`/v1/events${query ? `?${query}` : ""}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as ListEventsResponse;
}

export async function deleteEvents(ids: string[]): Promise<DeleteEventsResponse> {
  const res = await fetch("/v1/events", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as DeleteEventsResponse;
}
