import { EVENT_TYPES, EVENTS_DELETE_MAX_IDS } from "@personal-api/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteEvents, type EventFilters, listEvents, type StoredEvent } from "@/lib/events";
import { listIntegrations } from "@/lib/integrations";

const EVENTS_KEY = ["events"] as const;
const ROW_HEIGHT = 40;
const OVERSCAN = 5;
/** Used until the scroller has a measured height (and in jsdom, which has no layout). */
const FALLBACK_VIEWPORT = 448;
const LOAD_MORE_THRESHOLD = 10;

/** `datetime-local` has no zone: read it as local time, send it as UTC. */
function localToUtc(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function summary(event: StoredEvent): string {
  const { domain, path } = event.data;
  return typeof domain === "string" ? `${domain}${typeof path === "string" ? path : ""}` : "";
}

function EventDetail({
  event,
  integrationName,
  onClose,
}: {
  event: StoredEvent;
  integrationName: string;
  onClose: () => void;
}) {
  return (
    <aside
      role="dialog"
      aria-label="Event details"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{event.type}</h2>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Integration</dt>
        <dd>{integrationName}</dd>
        <dt className="text-muted-foreground">Origin</dt>
        <dd>{event.origin}</dd>
        <dt className="text-muted-foreground">Occurred</dt>
        <dd>{event.occurredAt}</dd>
        <dt className="text-muted-foreground">Received</dt>
        <dd>{event.receivedAt}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd>{event.tags.length > 0 ? event.tags.join(", ") : "none"}</dd>
      </dl>
      <pre
        data-testid="event-json"
        className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
      >
        {JSON.stringify(event, null, 2)}
      </pre>
    </aside>
  );
}

function FilterForm({
  integrations,
  onApply,
}: {
  integrations: { id: string; name: string }[];
  onApply: (filters: EventFilters) => void;
}) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const filters: EventFilters = {};
    if (text("source")) filters.source = text("source");
    if (text("type")) filters.type = text("type");
    if (text("domain")) filters.domain = text("domain").toLowerCase();
    const from = localToUtc(text("from"));
    const to = localToUtc(text("to"));
    if (from) filters.from = from;
    if (to) filters.to = to;
    onApply(filters);
  }
  return (
    <form
      onSubmit={onSubmit}
      aria-label="Filters"
      className="grid gap-3 rounded-md border p-4 sm:grid-cols-2"
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        Source
        <select name="source" className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">All sources</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Type
        <select name="type" className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">All types</option>
          {[...EVENT_TYPES].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="events-from" className="flex flex-col gap-1 text-sm font-medium">
        From
        <Input id="events-from" name="from" type="datetime-local" />
      </label>
      <label htmlFor="events-to" className="flex flex-col gap-1 text-sm font-medium">
        To
        <Input id="events-to" name="to" type="datetime-local" />
      </label>
      <label
        htmlFor="events-domain"
        className="flex flex-col gap-1 text-sm font-medium sm:col-span-2"
      >
        Domain
        <Input
          id="events-domain"
          name="domain"
          type="text"
          placeholder="example.com"
          maxLength={253}
        />
      </label>
      <div className="sm:col-span-2">
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}

export function EventsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<EventFilters>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const scroller = useRef<HTMLDivElement>(null);

  const integrations = useQuery({ queryKey: ["integrations"], queryFn: listIntegrations });
  const events = useInfiniteQuery({
    queryKey: [...EVENTS_KEY, filters],
    queryFn: ({ pageParam }) => listEvents(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => events.data?.pages.flatMap((p) => p.events) ?? [], [events.data]);
  const names = useMemo(
    () => new Map((integrations.data ?? []).map((i) => [i.id, i.name])),
    [integrations.data],
  );

  useEffect(() => {
    const height = scroller.current?.clientHeight;
    if (height) setViewport(height);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = events;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && last >= rows.length - LOAD_MORE_THRESHOLD) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, last, rows.length]);

  const remove = useMutation({
    mutationFn: deleteEvents,
    onSuccess: (_res, ids) => {
      setConfirming(false);
      setSelected(new Set());
      setOpenId((id) => (id && ids.includes(id) ? null : id));
      void queryClient.invalidateQueries({ queryKey: EVENTS_KEY });
    },
  });

  function applyFilters(next: EventFilters) {
    setFilters(next);
    setSelected(new Set());
    setOpenId(null);
    setConfirming(false);
    setScrollTop(0);
    if (scroller.current) scroller.current.scrollTop = 0;
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < EVENTS_DELETE_MAX_IDS) next.add(id);
      return next;
    });
  }

  const open = rows.find((e) => e.id === openId) ?? null;
  const atLimit = selected.size >= EVENTS_DELETE_MAX_IDS;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>

      <FilterForm integrations={integrations.data ?? []} onApply={applyFilters} />

      {selected.size > 0 && !confirming && (
        <div className="flex items-center gap-3">
          <span role="status" className="text-sm">
            {selected.size} selected
            {atLimit ? ` (at most ${EVENTS_DELETE_MAX_IDS} per delete)` : ""}
          </span>
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            Delete selected
          </Button>
          <Button variant="outline" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Confirm deleting events"
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <p className="text-sm">
            Delete <strong>{selected.size}</strong> selected event{selected.size === 1 ? "" : "s"}?
            This cannot be undone.
          </p>
          {remove.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not delete. Try again.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate([...selected])}
            >
              Confirm delete
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {events.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
      {events.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load events.
        </p>
      )}
      {events.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No events match.</p>
      )}
      {rows.length > 0 && (
        <div
          ref={scroller}
          data-testid="events-scroller"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="h-[28rem] overflow-auto rounded-md border"
        >
          <div
            style={{
              paddingTop: first * ROW_HEIGHT,
              paddingBottom: (rows.length - last) * ROW_HEIGHT,
            }}
          >
            <table
              aria-label="Events"
              aria-rowcount={rows.length}
              className="w-full table-fixed text-sm"
            >
              <tbody>
                {rows.slice(first, last).map((event, i) => (
                  <tr
                    key={event.id}
                    aria-rowindex={first + i + 1}
                    style={{ height: ROW_HEIGHT }}
                    className="border-b"
                  >
                    <td className="w-10 px-3">
                      <input
                        type="checkbox"
                        aria-label={`Select event ${first + i + 1}`}
                        checked={selected.has(event.id)}
                        disabled={atLimit && !selected.has(event.id)}
                        onChange={() => toggle(event.id)}
                      />
                    </td>
                    <td className="w-48 truncate font-mono text-xs">
                      <button
                        type="button"
                        aria-label={`Open event ${first + i + 1}`}
                        onClick={() => setOpenId(event.id)}
                        className="underline"
                      >
                        {event.occurredAt}
                      </button>
                    </td>
                    <td className="w-48 truncate">{event.type}</td>
                    <td className="w-36 truncate text-muted-foreground">
                      {names.get(event.integrationId) ?? "Unknown"}
                    </td>
                    <td className="truncate">{summary(event)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {isFetchingNextPage && <p className="text-sm text-muted-foreground">Loading more...</p>}

      {open && (
        <EventDetail
          event={open}
          integrationName={names.get(open.integrationId) ?? "Unknown"}
          onClose={() => setOpenId(null)}
        />
      )}
    </main>
  );
}
