import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AppNav } from "@/components/app-nav";
import { CategorySplit } from "@/components/category-split";
import { Recommendations } from "@/components/recommendations";
import { Button } from "@/components/ui/button";
import { type ActivityDay, formatDuration, getInsights, type Insights } from "@/lib/activity";
import { signOut } from "@/lib/auth";
import { clearHabits } from "@/lib/habits";
import { clearDismissed } from "@/lib/recommendations";
import { getSettings } from "@/lib/settings";
import { resetWelcome } from "@/lib/welcome";

/** Weekday and day of month for a `YYYY-MM-DD` local date (already in the user's zone). */
function dayLabel(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
  });
  return `${weekday} ${Number(date.slice(8))}`;
}

function Stat({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold" data-testid={`stat-${label}`}>
        {formatDuration(ms)}
      </span>
    </div>
  );
}

function DailyBars({ days, today }: { days: ActivityDay[]; today: string }) {
  const max = Math.max(1, ...days.map((d) => d.activeMs));
  return (
    <section aria-labelledby="daily-heading" className="flex flex-col gap-2">
      <h2 id="daily-heading" className="text-sm font-medium">
        Last 7 days
      </h2>
      <ol className="flex h-40 items-end gap-2" aria-label="Active time per day">
        {days.map((d) => (
          <li
            key={d.date}
            className="flex h-full flex-1 flex-col items-center justify-end gap-1"
            aria-label={`${dayLabel(d.date)}: ${formatDuration(d.activeMs)}`}
          >
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              {formatDuration(d.activeMs)}
            </span>
            <div
              className={`w-full rounded-sm ${d.date === today ? "bg-primary" : "bg-primary/50"}`}
              style={{ height: `${(d.activeMs / max) * 100}%` }}
              aria-hidden="true"
            />
            <span className="text-xs" aria-hidden="true">
              {dayLabel(d.date)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TopDomains({ domains }: { domains: Insights["domains"] }) {
  const max = Math.max(1, ...domains.map((d) => d.activeMs));
  return (
    <section aria-labelledby="domains-heading" className="flex flex-col gap-2">
      <h2 id="domains-heading" className="text-sm font-medium">
        Top sites
      </h2>
      <ol className="flex flex-col gap-2" aria-label="Top sites by active time">
        {domains.map((d) => (
          <li key={d.domain} className="flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <Link
                to="/sites/$domain"
                params={{ domain: d.domain }}
                className="truncate underline"
              >
                {d.domain}
              </Link>
              <span className="text-muted-foreground">{formatDuration(d.activeMs)}</span>
            </div>
            <div className="h-1.5 w-full rounded-sm bg-muted" aria-hidden="true">
              <div
                className="h-full rounded-sm bg-primary/70"
                style={{ width: `${(d.activeMs / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EmptyInsights() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border p-4">
      <p className="font-medium">No activity in the last 7 days</p>
      <p className="text-sm text-muted-foreground">
        Connect your browser and choose what to track, and your time per site shows up here.
      </p>
      <Link to="/welcome" onClick={resetWelcome} className="text-sm underline">
        Open the setup wizard
      </Link>
    </div>
  );
}

function InsightsPanel() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  const insights = useQuery({
    queryKey: ["insights", timeZone],
    queryFn: () => getInsights(timeZone as string),
    enabled: timeZone !== undefined,
  });

  if (settings.isError || insights.isError) {
    return <p className="text-sm text-destructive">Could not load your activity.</p>;
  }
  if (!insights.data) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your activity…
      </p>
    );
  }

  const { days, domains, window } = insights.data;
  const week = days.reduce((sum, d) => sum + d.activeMs, 0);
  if (week === 0 && domains.length === 0) return <EmptyInsights />;
  const today = days.find((d) => d.date === window.today)?.activeMs ?? 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Today" ms={today} />
        <Stat label="Last 7 days" ms={week} />
      </div>
      <DailyBars days={days} today={window.today} />
      <CategorySplit timeZone={timeZone as string} />
      <Recommendations />
      {domains.length > 0 && <TopDomains domains={domains} />}
      <p className="text-xs text-muted-foreground">Days are cut in {timeZone}.</p>
    </div>
  );
}

export function IndexPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function onSignOut() {
    await signOut();
    // Drop every cached query so the next user on this browser never sees the last one's data.
    queryClient.clear();
    clearDismissed();
    clearHabits();
    await navigate({ to: "/login" });
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Personal API</h1>
          <p className="text-sm text-muted-foreground">Your Data. Your Rules.</p>
        </div>
        <Button variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </header>
      <AppNav />
      <section aria-labelledby="insights-heading" className="flex flex-col gap-4">
        <h2 id="insights-heading" className="text-xl font-semibold">
          Insights
        </h2>
        <InsightsPanel />
      </section>
    </main>
  );
}
