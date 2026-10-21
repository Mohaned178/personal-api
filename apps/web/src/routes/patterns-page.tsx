import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppNav } from "@/components/app-nav";
import {
  type ActivityHourCell,
  type ActivitySession,
  formatDuration,
  getHours,
  getTodaySessions,
  getWeekComparison,
  type SiteComparison,
} from "@/lib/activity";
import { getSettings } from "@/lib/settings";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Shared shell of a section with its own loading, error and empty states. */
function Section({
  id,
  title,
  state,
  empty,
  children,
}: {
  id: string;
  title: string;
  state: "loading" | "error" | "empty" | "ready";
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-sm font-medium">
        {title}
      </h2>
      {state === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {state === "error" && <p className="text-sm text-destructive">Could not load this view.</p>}
      {state === "empty" && <p className="text-sm text-muted-foreground">{empty}</p>}
      {state === "ready" && children}
    </section>
  );
}

function Heatmap({ cells }: { cells: ActivityHourCell[] }) {
  const byCell = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c.activeMs]));
  const max = Math.max(1, ...cells.map((c) => c.activeMs));
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Active time by weekday and hour"
        className="border-separate border-spacing-0.5"
      >
        <thead>
          <tr>
            <th aria-label="Weekday" />
            {HOURS.map((hour) => (
              <th key={hour} scope="col" className="text-[10px] font-normal text-muted-foreground">
                <span aria-hidden="true">{hour % 6 === 0 ? hour : ""}</span>
                <span className="sr-only">{hourLabel(hour)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEKDAYS.map((name, weekday) => (
            <tr key={name}>
              <th scope="row" className="pr-2 text-left text-xs font-normal">
                {name}
              </th>
              {HOURS.map((hour) => {
                const ms = byCell.get(`${weekday}-${hour}`) ?? 0;
                return (
                  <td
                    key={hour}
                    aria-label={`${name} ${hourLabel(hour)}: ${formatDuration(ms)}`}
                    title={`${name} ${hourLabel(hour)}: ${formatDuration(ms)}`}
                    className="h-4 w-4 rounded-sm bg-muted p-0"
                  >
                    <div
                      className="h-full w-full rounded-sm bg-primary"
                      style={{ opacity: ms === 0 ? 0 : 0.15 + 0.85 * (ms / max) }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `+20m`, `-5m`, or `no change`. */
function change(thisWeekMs: number, lastWeekMs: number): string {
  const diff = thisWeekMs - lastWeekMs;
  if (diff === 0) return "no change";
  return `${diff > 0 ? "+" : "-"}${formatDuration(Math.abs(diff))}`;
}

function WeekComparison({ rows }: { rows: SiteComparison[] }) {
  return (
    <table aria-label="This week against last week" className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="font-normal">
            Site
          </th>
          <th scope="col" className="text-right font-normal">
            This week
          </th>
          <th scope="col" className="text-right font-normal">
            Last week
          </th>
          <th scope="col" className="text-right font-normal">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.domain}>
            <th scope="row" className="truncate py-1 text-left font-normal">
              <Link to="/sites/$domain" params={{ domain: r.domain }} className="underline">
                {r.domain}
              </Link>
            </th>
            <td className="text-right">{formatDuration(r.thisWeekMs)}</td>
            <td className="text-right">{formatDuration(r.lastWeekMs)}</td>
            <td className="text-right text-muted-foreground">
              {change(r.thisWeekMs, r.lastWeekMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function timeOfDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function Timeline({ sessions, timeZone }: { sessions: ActivitySession[]; timeZone: string }) {
  return (
    <ol aria-label="Today's sessions" className="flex flex-col gap-1">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {timeOfDay(s.startedAt, timeZone)} to {timeOfDay(s.endedAt, timeZone)}
          </span>
          <Link to="/sites/$domain" params={{ domain: s.domain }} className="flex-1 truncate">
            {s.domain}
          </Link>
          <span>{formatDuration(s.durationMs)}</span>
        </li>
      ))}
    </ol>
  );
}

type QueryState = { isError: boolean; data: unknown };
function stateOf(
  q: QueryState,
  isEmpty: (data: never) => boolean,
): "loading" | "error" | "empty" | "ready" {
  if (q.isError) return "error";
  if (q.data === undefined) return "loading";
  return isEmpty(q.data as never) ? "empty" : "ready";
}

export function PatternsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  const enabled = timeZone !== undefined;
  const hours = useQuery({
    queryKey: ["patterns", "hours", timeZone],
    queryFn: () => getHours(timeZone as string),
    enabled,
  });
  const compare = useQuery({
    queryKey: ["patterns", "compare", timeZone],
    queryFn: () => getWeekComparison(timeZone as string),
    enabled,
  });
  const sessions = useQuery({
    queryKey: ["patterns", "sessions", timeZone],
    queryFn: () => getTodaySessions(timeZone as string),
    enabled,
  });
  const withZone = (q: QueryState): QueryState =>
    settings.isError ? { isError: true, data: undefined } : q;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Patterns</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </header>
      <AppNav />
      <Section
        id="timeline-heading"
        title="Today's sessions"
        state={stateOf(withZone(sessions), (d: ActivitySession[]) => d.length === 0)}
        empty="No sessions yet today."
      >
        <Timeline sessions={sessions.data ?? []} timeZone={timeZone ?? "UTC"} />
      </Section>
      <Section
        id="compare-heading"
        title="This week against last week"
        state={stateOf(withZone(compare), (d: SiteComparison[]) => d.length === 0)}
        empty="No activity in the last 2 weeks."
      >
        <WeekComparison rows={compare.data ?? []} />
      </Section>
      <Section
        id="heatmap-heading"
        title="When you browse (last 4 weeks)"
        state={stateOf(withZone(hours), (d: ActivityHourCell[]) => d.length === 0)}
        empty="No activity in the last 4 weeks."
      >
        <Heatmap cells={hours.data ?? []} />
      </Section>
      <p className="text-xs text-muted-foreground">
        Days and hours are cut in {timeZone ?? "your time zone"}.
      </p>
    </main>
  );
}
