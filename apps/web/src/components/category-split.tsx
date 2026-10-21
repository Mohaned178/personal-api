import type { Category } from "@personal-api/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDuration } from "@/lib/activity";
import { getCategoryDays, goalProgress, listGoals, totalsOf } from "@/lib/habits";

const ROWS: Array<{ category: Category; label: string; bar: string }> = [
  { category: "productive", label: "Productive", bar: "bg-emerald-600" },
  { category: "neutral", label: "Neutral", bar: "bg-muted-foreground/50" },
  { category: "distracting", label: "Distracting", bar: "bg-red-600" },
];

const GOAL_LABEL = { distracting: "Distracting", neutral: "Neutral" } as const;

/** `1 day`, `5 days`, or `30+ days` when the streak fills the whole window. */
const streakText = (streak: number, capped: boolean): string =>
  `${streak}${capped ? "+" : ""} ${streak === 1 && !capped ? "day" : "days"}`;

/**
 * The week split into productive, neutral and distracting time (M9-07), and the progress of the
 * goals ("under 1h of distracting sites a day") with their streak. The split is computed by the
 * server from the built-in list and the user's own overrides.
 */
export function CategorySplit({ timeZone }: { timeZone: string }) {
  const split = useQuery({
    queryKey: ["category-days", timeZone],
    queryFn: () => getCategoryDays(timeZone),
  });
  const goals = useQuery({ queryKey: ["goals"], queryFn: listGoals });

  if (split.isError) {
    return <p className="text-sm text-destructive">Could not load your categories.</p>;
  }
  if (!split.data) {
    return <p className="text-sm text-muted-foreground">Loading your categories…</p>;
  }

  const { days } = split.data;
  const week = totalsOf(days.slice(-7));
  return (
    <section aria-labelledby="categories-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="categories-heading" className="text-sm font-medium">
          By category, last 7 days
        </h2>
        <Link to="/categories" className="text-sm underline">
          Edit categories and goals
        </Link>
      </div>
      {week.totalMs === 0 ? (
        <p className="text-sm text-muted-foreground">No time to split yet.</p>
      ) : (
        <>
          <div
            className="flex h-3 w-full overflow-hidden rounded-sm bg-muted"
            role="img"
            aria-label="Share of time by category"
          >
            {ROWS.map(({ category, bar }) => (
              <div
                key={category}
                className={bar}
                style={{ width: `${(week[`${category}Ms`] / week.totalMs) * 100}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1" aria-label="Time by category">
            {ROWS.map(({ category, label, bar }) => (
              <li key={category} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`size-2.5 rounded-full ${bar}`} aria-hidden="true" />
                  {label}
                </span>
                <span className="text-muted-foreground" data-testid={`split-${category}`}>
                  {formatDuration(week[`${category}Ms`])} (
                  {Math.round((week[`${category}Ms`] / week.totalMs) * 100)}%)
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {goals.data && goals.data.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Goals">
          {goals.data.map((goal) => {
            const progress = goalProgress(days, goal.category, goal.minutes);
            const over = progress.todayMs > goal.minutes * 60_000;
            return (
              <li key={goal.category} className="flex flex-col text-sm">
                <span>
                  {GOAL_LABEL[goal.category]} today: {formatDuration(progress.todayMs)} of{" "}
                  {formatDuration(goal.minutes * 60_000)}
                  {over ? " (over the goal)" : ""}
                </span>
                <span className="text-muted-foreground" data-testid={`streak-${goal.category}`}>
                  Streak: {streakText(progress.streak, progress.capped)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
