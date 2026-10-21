import {
  CATEGORIES,
  CATEGORY_ENTRIES_MAX,
  type Category,
  type CategoryEntry,
  type CategoryList,
  categoryEntrySchema,
  categoryListSchema,
  DEFAULT_CATEGORIES,
  GOAL_MAX_MINUTES,
  GOAL_MIN_MINUTES,
  type Goals,
  goalsSchema,
} from "@personal-api/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { CATEGORY_LABEL } from "@/components/category-split";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDuration } from "@/lib/activity";
import {
  GOAL_CATEGORIES,
  type GoalCategory,
  type GoalProgress,
  getDayDomains,
  goalProgress,
  MIN,
  readCategories,
  readGoals,
  saveCategories,
  saveGoals,
} from "@/lib/habits";
import { getSettings } from "@/lib/settings";

const STREAK_DAYS = 30;

const SITE_HELP = "Enter a site such as youtube.com or *.youtube.com.";
const TAKEN = "That site is already in the list. Change its category instead.";
const FULL = `The list holds up to ${CATEGORY_ENTRIES_MAX} sites.`;
const GOAL_HELP = `Enter between ${GOAL_MIN_MINUTES} and ${GOAL_MAX_MINUTES} minutes, or leave it empty.`;

const GOAL_LABEL: Record<GoalCategory, string> = {
  distracting: "Distracting sites: under (minutes a day)",
  productive: "Productive sites: at least (minutes a day)",
};

function CategoryRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: CategoryEntry;
  onChange: (category: Category) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm">{entry.pattern}</span>
      <select
        aria-label={`Category of ${entry.pattern}`}
        value={entry.category}
        onChange={(e) => onChange(e.target.value as Category)}
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABEL[c]}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        aria-label={`Remove ${entry.pattern}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </li>
  );
}

function CategoryEditor() {
  const [list, setList] = useState<CategoryList>(readCategories);
  const [site, setSite] = useState("");
  const [category, setCategory] = useState<Category>("distracting");
  const [problem, setProblem] = useState<string | null>(null);

  function update(next: CategoryList) {
    setList(next);
    saveCategories(next);
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    const entry = categoryEntrySchema.safeParse({ pattern: site.trim().toLowerCase(), category });
    if (!entry.success) {
      setProblem(SITE_HELP);
      return;
    }
    if (list.some((e) => e.pattern === entry.data.pattern)) {
      setProblem(TAKEN);
      return;
    }
    const next = categoryListSchema.safeParse([...list, entry.data]);
    if (!next.success) {
      setProblem(FULL);
      return;
    }
    setProblem(null);
    setSite("");
    update(next.data);
  }

  return (
    <section aria-labelledby="categories-heading" className="flex flex-col gap-4">
      <h2 id="categories-heading" className="text-lg font-medium">
        Categories
      </h2>
      <p className="text-sm text-muted-foreground">
        Sort your sites into productive, neutral and distracting. A site that is not in the list is
        neutral. <code>*.example.com</code> covers every subdomain. The list is kept in this browser
        only; it is never sent to the server.
      </p>
      <form onSubmit={onAdd} noValidate className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <label htmlFor="category-site">Site</label>
          <Input
            id="category-site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="youtube.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="category-new">Category</label>
          <select
            id="category-new"
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Add site</Button>
      </form>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {CATEGORIES.map((c) => {
        const entries = list.filter((e) => e.category === c);
        if (entries.length === 0) return null;
        return (
          <section
            key={c}
            aria-label={`${CATEGORY_LABEL[c]} sites`}
            className="flex flex-col gap-2"
          >
            <h3 className="text-sm font-medium">{CATEGORY_LABEL[c]}</h3>
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => (
                <CategoryRow
                  key={entry.pattern}
                  entry={entry}
                  onChange={(next) =>
                    update(list.map((e) => (e === entry ? { ...e, category: next } : e)))
                  }
                  onRemove={() => update(list.filter((e) => e !== entry))}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {list.length === 0 && <p className="text-sm text-muted-foreground">The list is empty.</p>}
      <div>
        <Button type="button" variant="outline" onClick={() => update(DEFAULT_CATEGORIES)}>
          Reset to the starting list
        </Button>
      </div>
    </section>
  );
}

function ProgressLine({ progress }: { progress: GoalProgress }) {
  const under = progress.category === "distracting";
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  return (
    <li className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <span className="font-medium">
        {CATEGORY_LABEL[progress.category]}: {under ? "under" : "at least"}{" "}
        {formatDuration(progress.minutes * MIN)} a day
      </span>
      <span data-testid={`today-${progress.category}`}>
        Today so far: {formatDuration(progress.todayMs)}{" "}
        {progress.todayMet ? "(on track)" : "(not met yet)"}
      </span>
      <span data-testid={`streak-${progress.category}`}>
        Streak: {days(progress.streak)}
        {progress.streak === 0 ? "" : " in a row"}
      </span>
    </li>
  );
}

function GoalEditor() {
  const [goals, setGoals] = useState<Goals>(readGoals);
  const [text, setText] = useState<Record<GoalCategory, string>>(() => ({
    distracting: String(readGoals().distracting ?? ""),
    productive: String(readGoals().productive ?? ""),
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const timeZone = settings.data?.timeZone;
  const hasGoal = GOAL_CATEGORIES.some((c) => goals[c] !== undefined);
  const days = useQuery({
    queryKey: ["habit-days", timeZone, STREAK_DAYS],
    queryFn: () => getDayDomains(timeZone as string, STREAK_DAYS),
    enabled: timeZone !== undefined && hasGoal,
  });

  function onSave(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const next: Record<string, number> = {};
    for (const c of GOAL_CATEGORIES) {
      const value = text[c].trim();
      if (value !== "") next[c] = Number(value);
    }
    const parsed = goalsSchema.safeParse(next);
    if (!parsed.success) {
      setProblem(GOAL_HELP);
      return;
    }
    setProblem(null);
    saveGoals(parsed.data);
    setGoals(parsed.data);
    setSaved(true);
  }

  const list = readCategories();
  return (
    <section aria-labelledby="goals-heading" className="flex flex-col gap-4">
      <h2 id="goals-heading" className="text-lg font-medium">
        Daily goals
      </h2>
      <p className="text-sm text-muted-foreground">
        Keep distracting sites under a ceiling, or reach a floor of productive time. A day counts
        when something was tracked and it met the goal; a day with nothing tracked ends the streak.
        Goals are kept in this browser only.
      </p>
      <form onSubmit={onSave} noValidate className="flex flex-col gap-3">
        {GOAL_CATEGORIES.map((c) => (
          <div key={c} className="flex flex-col gap-1 text-sm">
            <label htmlFor={`goal-${c}`}>{GOAL_LABEL[c]}</label>
            <Input
              id={`goal-${c}`}
              type="number"
              inputMode="numeric"
              min={GOAL_MIN_MINUTES}
              max={GOAL_MAX_MINUTES}
              value={text[c]}
              onChange={(e) => setText({ ...text, [c]: e.target.value })}
              className="w-32"
            />
          </div>
        ))}
        <div>
          <Button type="submit">Save goals</Button>
        </div>
        {problem !== null && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-muted-foreground">
            Goals saved.
          </p>
        )}
      </form>
      {hasGoal && days.isError && (
        <p className="text-sm text-destructive">Could not load your progress.</p>
      )}
      {hasGoal && days.data && (
        <ul aria-label="Goal progress" className="flex flex-col gap-2">
          {GOAL_CATEGORIES.flatMap((c) => {
            const minutes = goals[c];
            return minutes === undefined ? [] : [goalProgress(days.data, list, c, minutes)];
          }).map((p) => (
            <ProgressLine key={p.category} progress={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CategoriesPage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Categories and goals</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      <CategoryEditor />
      <GoalEditor />
    </main>
  );
}
