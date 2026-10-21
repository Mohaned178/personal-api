import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AppNav } from "@/components/app-nav";
import { type ActivityDay, formatDuration, getSite, type SiteDetail } from "@/lib/activity";
import { getSettings } from "@/lib/settings";

/** Month and day of month for a `YYYY-MM-DD` local date (already in the user's zone). */
function dayLabel(date: string): string {
  const month = new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
  });
  return `${month} ${Number(date.slice(8))}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold" data-testid={`stat-${label}`}>
        {value}
      </span>
    </div>
  );
}

function DayBars({ days }: { days: ActivityDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.activeMs));
  return (
    <section aria-labelledby="site-days-heading" className="flex flex-col gap-2">
      <h2 id="site-days-heading" className="text-sm font-medium">
        Last 30 days
      </h2>
      <ol className="flex h-32 items-end gap-0.5" aria-label="Active time per day">
        {days.map((d) => (
          <li
            key={d.date}
            className="flex h-full flex-1 items-end"
            aria-label={`${dayLabel(d.date)}: ${formatDuration(d.activeMs)}`}
          >
            <div
              className="w-full rounded-sm bg-primary/70"
              style={{ height: `${(d.activeMs / max) * 100}%` }}
              aria-hidden="true"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Detail({ site }: { site: SiteDetail }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Time" value={formatDuration(site.activeMs)} />
        <Stat label="Visits" value={String(site.pageVisits)} />
        <Stat label="Average session" value={formatDuration(site.averageSessionMs)} />
        <Stat label="Longest session" value={formatDuration(site.longestSessionMs)} />
      </div>
      <DayBars days={site.days} />
      <section aria-labelledby="site-paths-heading" className="flex flex-col gap-2">
        <h2 id="site-paths-heading" className="text-sm font-medium">
          Top pages
        </h2>
        <ol aria-label="Top pages by active time" className="flex flex-col gap-1">
          {site.paths.map((p) => (
            <li key={p.path} className="flex justify-between gap-2 text-sm">
              <span className="truncate">{p.path}</span>
              <span className="text-muted-foreground">{formatDuration(p.activeMs)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function SitePanel({ domain }: { domain: string }) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  const site = useQuery({
    queryKey: ["site", domain, timeZone],
    queryFn: () => getSite(domain, timeZone as string),
    enabled: timeZone !== undefined,
  });
  if (settings.isError || site.isError) {
    return <p className="text-sm text-destructive">Could not load this site.</p>;
  }
  if (!site.data) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (site.data.activeMs === 0 && site.data.pageVisits === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity on this site in the last 30 days.</p>
    );
  }
  return <Detail site={site.data} />;
}

export function SitePage() {
  const { domain } = useParams({ from: "/sites/$domain" });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{domain}</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </header>
      <AppNav />
      <SitePanel domain={domain} />
    </main>
  );
}
