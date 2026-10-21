import { CATEGORIES } from "@personal-api/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CATEGORY_LABEL } from "@/components/category-split";
import { formatDuration } from "@/lib/activity";
import { getDayDomains, readCategories, SUMMARY_DAYS, weeklySummary } from "@/lib/habits";
import { listLimits } from "@/lib/limits";
import { getSettings } from "@/lib/settings";

/** `+1h 05m`, `-20m` or `no change`. */
export function formatChange(ms: number): string {
  if (ms === 0) return "no change";
  return `${ms > 0 ? "+" : "-"}${formatDuration(Math.abs(ms))}`;
}

function Changes({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ domain: string; thisWeekMs: number; lastWeekMs: number }>;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.domain} className="flex justify-between gap-2 text-sm">
            <Link to="/sites/$domain" params={{ domain: r.domain }} className="truncate underline">
              {r.domain}
            </Link>
            <span className="text-muted-foreground">
              {formatDuration(r.lastWeekMs)} → {formatDuration(r.thisWeekMs)} (
              {formatChange(r.thisWeekMs - r.lastWeekMs)})
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryBody({ timeZone }: { timeZone: string }) {
  const days = useQuery({
    queryKey: ["habit-days", timeZone, 2 * SUMMARY_DAYS],
    queryFn: () => getDayDomains(timeZone, 2 * SUMMARY_DAYS),
  });
  const limits = useQuery({ queryKey: ["limits"], queryFn: listLimits });

  if (days.isError || limits.isError) {
    return <p className="text-sm text-destructive">Could not load your summary.</p>;
  }
  if (!days.data || !limits.data) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your summary…
      </p>
    );
  }
  const s = weeklySummary(days.data, readCategories(), limits.data);
  if (s.thisWeek.totalMs === 0 && s.lastWeek.totalMs === 0) {
    return <p className="text-sm text-muted-foreground">No activity in the last two weeks.</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-normal">&nbsp;</th>
            <th className="py-1 font-normal">This week</th>
            <th className="py-1 font-normal">Last week</th>
            <th className="py-1 font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="row-total">
            <th className="py-1 text-left font-medium">All sites</th>
            <td>{formatDuration(s.thisWeek.totalMs)}</td>
            <td>{formatDuration(s.lastWeek.totalMs)}</td>
            <td>{formatChange(s.thisWeek.totalMs - s.lastWeek.totalMs)}</td>
          </tr>
          {CATEGORIES.map((c) => (
            <tr key={c} data-testid={`row-${c}`}>
              <th className="py-1 text-left font-medium">{CATEGORY_LABEL[c]}</th>
              <td>{formatDuration(s.thisWeek[c])}</td>
              <td>{formatDuration(s.lastWeek[c])}</td>
              <td>{formatChange(s.thisWeek[c] - s.lastWeek[c])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section aria-labelledby="kept-heading" className="flex flex-col gap-1">
        <h3 id="kept-heading" className="text-sm font-medium">
          Limits kept
        </h3>
        {s.limits.checked === 0 ? (
          <p className="text-sm text-muted-foreground">
            {limits.data.length === 0
              ? "You have no limits yet."
              : "No limit was checked: nothing was tracked this week."}
          </p>
        ) : (
          <p className="text-sm" data-testid="limits-kept">
            {s.limits.kept} of {s.limits.checked} limit-days stayed within the limit.
          </p>
        )}
      </section>
      <Changes title="Up most" rows={s.increases} />
      <Changes title="Down most" rows={s.decreases} />
      <p className="text-xs text-muted-foreground">
        This week is the last 7 days, today included; days are cut in {timeZone}. Only each day's
        busiest 100 sites are counted.
      </p>
    </div>
  );
}

export function SummaryPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly summary</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      {settings.isError && <p className="text-sm text-destructive">Could not load your summary.</p>}
      {timeZone !== undefined && <SummaryBody timeZone={timeZone} />}
    </main>
  );
}
