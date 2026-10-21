import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDuration } from "@/lib/activity";
import { getWeeklySummary, type WeeklySummary } from "@/lib/habits";
import { getSettings } from "@/lib/settings";

const CATEGORY_ROWS = [
  { key: "productiveMs", label: "Productive" },
  { key: "neutralMs", label: "Neutral" },
  { key: "distractingMs", label: "Distracting" },
] as const;

/** `+1h 05m`, `-20m` or `no change`. */
export function formatChange(ms: number): string {
  if (ms === 0) return "no change";
  return `${ms > 0 ? "+" : "-"}${formatDuration(Math.abs(ms))}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Compare({ summary }: { summary: WeeklySummary }) {
  const { thisWeek, lastWeek } = summary;
  return (
    <section aria-labelledby="compare-heading" className="flex flex-col gap-2">
      <h2 id="compare-heading" className="text-lg font-medium">
        This week against last week
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-normal">Time</th>
            <th className="py-1 font-normal">This week</th>
            <th className="py-1 font-normal">Last week</th>
            <th className="py-1 font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORY_ROWS.map(({ key, label }) => (
            <tr key={key}>
              <th scope="row" className="py-1 text-left font-normal">
                {label}
              </th>
              <td data-testid={`this-${key}`}>{formatDuration(thisWeek[key])}</td>
              <td>{formatDuration(lastWeek[key])}</td>
              <td>{formatChange(thisWeek[key] - lastWeek[key])}</td>
            </tr>
          ))}
          <tr className="border-t font-medium">
            <th scope="row" className="py-1 text-left font-medium">
              All sites
            </th>
            <td data-testid="this-total">{formatDuration(thisWeek.totalMs)}</td>
            <td>{formatDuration(lastWeek.totalMs)}</td>
            <td>{formatChange(thisWeek.totalMs - lastWeek.totalMs)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Kept({ summary }: { summary: WeeklySummary }) {
  const { goals, limits } = summary;
  return (
    <section aria-labelledby="kept-heading" className="flex flex-col gap-2">
      <h2 id="kept-heading" className="text-lg font-medium">
        Goals and limits
      </h2>
      {goals.length === 0 && limits.total === 0 && (
        <p className="text-sm text-muted-foreground">
          You have no goals or limits yet.{" "}
          <Link to="/categories" className="underline">
            Set a goal
          </Link>{" "}
          or{" "}
          <Link to="/limits" className="underline">
            add a limit
          </Link>
          .
        </p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {goals.map((goal) => (
          <li key={goal.category} data-testid={`goal-${goal.category}`}>
            Under {formatDuration(goal.minutes * 60_000)} of {goal.category} sites: kept{" "}
            {goal.daysKept} of {plural(goal.days, "day")}. Streak: {goal.streak}
            {goal.capped ? "+" : ""} {goal.streak === 1 && !goal.capped ? "day" : "days"}.
          </li>
        ))}
        {limits.total > 0 && (
          <li data-testid="limits-kept">
            Limits kept: {limits.kept} of {plural(limits.total, "limit day")}.
          </li>
        )}
        {limits.skipped > 0 && (
          <li className="text-muted-foreground">
            {plural(limits.skipped, "limit")} on a group of subdomains (<code>*.</code>) are not
            counted here.
          </li>
        )}
      </ul>
    </section>
  );
}

function Changes({ summary }: { summary: WeeklySummary }) {
  return (
    <section aria-labelledby="changes-heading" className="flex flex-col gap-2">
      <h2 id="changes-heading" className="text-lg font-medium">
        Biggest changes
      </h2>
      {summary.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No site changed between the two weeks.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Sites that changed the most">
          {summary.changes.map((change) => (
            <li key={change.domain} className="flex justify-between gap-2">
              <Link to="/sites/$domain" params={{ domain: change.domain }} className="underline">
                {change.domain}
              </Link>
              <span className="text-muted-foreground">
                {formatChange(change.deltaMs)} ({formatDuration(change.lastWeekMs)} to{" "}
                {formatDuration(change.thisWeekMs)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SummaryPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  const summary = useQuery({
    queryKey: ["weekly-summary", timeZone],
    queryFn: () => getWeeklySummary(timeZone as string),
    enabled: timeZone !== undefined,
  });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly summary</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      {(settings.isError || summary.isError) && (
        <p className="text-sm text-destructive">Could not load your summary.</p>
      )}
      {!summary.data && !settings.isError && !summary.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading your summary…
        </p>
      )}
      {summary.data &&
        (summary.data.thisWeek.totalMs === 0 && summary.data.lastWeek.totalMs === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity in the last 14 days. Once the extension has tracked some browsing, your week
            shows up here.
          </p>
        ) : (
          <>
            <Compare summary={summary.data} />
            <Kept summary={summary.data} />
            <Changes summary={summary.data} />
            <p className="text-xs text-muted-foreground">
              The last 7 days against the 7 before them, with days cut in {timeZone}. Nothing is
              sent by email.
            </p>
          </>
        ))}
    </main>
  );
}
