import { CATEGORIES, type Category } from "@personal-api/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDuration, getDomainTotals, insightsWindow } from "@/lib/activity";
import { readCategories, splitByCategory } from "@/lib/habits";

export const CATEGORY_LABEL: Record<Category, string> = {
  productive: "Productive",
  neutral: "Neutral",
  distracting: "Distracting",
};

const CATEGORY_BAR: Record<Category, string> = {
  productive: "bg-primary",
  neutral: "bg-muted-foreground/40",
  distracting: "bg-destructive/70",
};

/** The last 7 days of time split into productive, neutral and distracting (M9-07). */
export function CategorySplit({ timeZone }: { timeZone: string }) {
  const totals = useQuery({
    queryKey: ["category-split", timeZone],
    queryFn: () => getDomainTotals(insightsWindow(new Date(), timeZone)),
  });

  if (totals.isError) {
    return <p className="text-sm text-destructive">Could not load your categories.</p>;
  }
  if (!totals.data) return null;
  const split = splitByCategory(totals.data, readCategories());
  const total = CATEGORIES.reduce((sum, c) => sum + split[c], 0);
  if (total === 0) return null;
  const percent = (c: Category) => Math.round((split[c] / total) * 100);

  return (
    <section aria-labelledby="split-heading" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="split-heading" className="text-sm font-medium">
          Time by category
        </h2>
        <Link to="/categories" className="text-xs underline">
          Edit categories and goals
        </Link>
      </div>
      <div
        role="img"
        aria-label={CATEGORIES.map((c) => `${CATEGORY_LABEL[c]} ${percent(c)}%`).join(", ")}
        className="flex h-3 w-full overflow-hidden rounded-sm bg-muted"
      >
        {CATEGORIES.map((c) => (
          <div
            key={c}
            className={CATEGORY_BAR[c]}
            style={{ width: `${(split[c] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul aria-label="Time by category" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {CATEGORIES.map((c) => (
          <li key={c} className="flex items-center gap-2">
            <span className={`size-2.5 rounded-sm ${CATEGORY_BAR[c]}`} aria-hidden="true" />
            <span>{CATEGORY_LABEL[c]}</span>
            <span className="text-muted-foreground" data-testid={`split-${c}`}>
              {formatDuration(split[c])} · {percent(c)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
