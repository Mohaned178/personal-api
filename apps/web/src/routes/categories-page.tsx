import {
  CATEGORIES,
  type Category,
  type CategoryRule,
  categoryRuleSaveSchema,
  GOAL_CATEGORIES,
  GOAL_MAX_MINUTES,
  GOAL_MIN_MINUTES,
  type Goal,
  type GoalCategory,
  goalSaveSchema,
} from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createCategory,
  deleteCategory,
  deleteGoal,
  HabitsError,
  listCategories,
  listGoals,
  putGoal,
  replaceCategory,
} from "@/lib/habits";

const CATEGORIES_KEY = ["categories"] as const;
const GOALS_KEY = ["goals"] as const;

const LABEL: Record<Category, string> = {
  productive: "Productive",
  neutral: "Neutral",
  distracting: "Distracting",
};
const SITE_HELP = "Enter a site such as youtube.com or *.youtube.com.";
const MINUTES_HELP = `Enter between ${GOAL_MIN_MINUTES} and ${GOAL_MAX_MINUTES} minutes.`;
const TAKEN = "That site already has a category. Change that one instead.";
const FAILED = "Could not save.";

/** The message for a failed save, never repeating what the user typed. */
const messageFor = (error: unknown): string =>
  error instanceof HabitsError && error.code === "category.pattern_taken" ? TAKEN : FAILED;

function GoalRow({ category, goal }: { category: GoalCategory; goal: Goal | undefined }) {
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState(goal ? String(goal.minutes) : "");
  const parsed = goalSaveSchema.safeParse({
    minutes: minutes.trim() === "" ? Number.NaN : Number(minutes),
  });
  const changed = minutes !== (goal ? String(goal.minutes) : "");
  const refresh = () => queryClient.invalidateQueries({ queryKey: GOALS_KEY });
  const save = useMutation({
    mutationFn: async () => {
      if (parsed.success) await putGoal(category, parsed.data.minutes);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteGoal(category),
    onSuccess: async () => {
      setMinutes("");
      await refresh();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (parsed.success) save.mutate();
  }

  return (
    <li>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <label htmlFor={`goal-${category}`} className="min-w-0 flex-1 text-sm">
          Stay under, in minutes a day, on {LABEL[category].toLowerCase()} sites
        </label>
        <Input
          id={`goal-${category}`}
          type="number"
          inputMode="numeric"
          min={GOAL_MIN_MINUTES}
          max={GOAL_MAX_MINUTES}
          aria-invalid={minutes !== "" && !parsed.success}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          placeholder="No goal"
          className="w-28"
        />
        <Button
          type="submit"
          aria-label={`Save the ${category} goal`}
          disabled={!parsed.success || !changed || save.isPending}
        >
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-label={`Remove the ${category} goal`}
          disabled={!goal || remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
        {minutes !== "" && !parsed.success && (
          <span role="alert" className="basis-full text-sm text-destructive">
            {MINUTES_HELP}
          </span>
        )}
        {(save.isError || remove.isError) && (
          <span role="alert" className="basis-full text-sm text-destructive">
            {FAILED}
          </span>
        )}
      </form>
    </li>
  );
}

function Goals() {
  const goals = useQuery({ queryKey: GOALS_KEY, queryFn: listGoals });
  return (
    <section className="flex flex-col gap-3" aria-label="Goals">
      <h2 className="text-lg font-medium">Goals</h2>
      <p className="text-sm text-muted-foreground">
        A goal is a ceiling for one day. Stay under it and your streak grows; go over it and the
        streak starts again. Insights shows today against the goal.
      </p>
      {goals.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {goals.isError && <p className="text-sm text-destructive">Could not load goals.</p>}
      {goals.data && (
        <ul className="flex flex-col gap-3">
          {GOAL_CATEGORIES.map((category) => (
            <GoalRow
              key={`${category}:${goals.data.find((g) => g.category === category)?.minutes}`}
              category={category}
              goal={goals.data.find((g) => g.category === category)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CategorySelect({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label?: string;
  value: Category;
  onChange: (category: Category) => void;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as Category)}
      className="h-9 rounded-md border bg-background px-2 text-sm"
    >
      {CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {LABEL[category]}
        </option>
      ))}
    </select>
  );
}

function OverrideRow({ rule }: { rule: CategoryRule }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY });
  const change = useMutation({
    mutationFn: (category: Category) =>
      replaceCategory(rule.id, { pattern: rule.pattern, category }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => deleteCategory(rule.id), onSuccess: refresh });
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.pattern}</span>
      <CategorySelect
        label={`Category for ${rule.pattern}`}
        value={rule.category}
        onChange={(category) => change.mutate(category)}
      />
      <Button
        type="button"
        variant="outline"
        aria-label={`Remove ${rule.pattern}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        Remove
      </Button>
      {(change.isError || remove.isError) && (
        <span role="alert" className="basis-full text-sm text-destructive">
          {FAILED}
        </span>
      )}
    </li>
  );
}

function AddOverride() {
  const queryClient = useQueryClient();
  const [site, setSite] = useState("");
  const [category, setCategory] = useState<Category>("distracting");
  const [problem, setProblem] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: createCategory,
    onSuccess: async () => {
      setSite("");
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
    onError: (error) => setProblem(messageFor(error)),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = categoryRuleSaveSchema.safeParse({
      pattern: site.trim().toLowerCase(),
      category,
    });
    if (!parsed.success) {
      setProblem(SITE_HELP);
      return;
    }
    setProblem(null);
    add.mutate(parsed.data);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <label htmlFor="category-site">Site</label>
          <Input
            id="category-site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="category-choice">Category</label>
          <CategorySelect id="category-choice" value={category} onChange={setCategory} />
        </div>
        <Button type="submit" disabled={add.isPending}>
          Add site
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}

function Overrides() {
  const categories = useQuery({ queryKey: CATEGORIES_KEY, queryFn: listCategories });
  return (
    <section className="flex flex-col gap-3" aria-label="Your sites">
      <h2 className="text-lg font-medium">Your sites</h2>
      <p className="text-sm text-muted-foreground">
        Every site is productive, neutral or distracting. A site you add here beats the built-in
        list, and it changes your past numbers too, because the split is worked out when you look at
        it. Use <code>*.example.com</code> for every subdomain.
      </p>
      <AddOverride />
      {categories.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {categories.isError && <p className="text-sm text-destructive">Could not load categories.</p>}
      {categories.data?.rules.length === 0 && (
        <p className="text-sm text-muted-foreground">No sites of your own yet.</p>
      )}
      {categories.data && categories.data.rules.length > 0 && (
        <ul className="flex flex-col gap-3">
          {categories.data.rules.map((rule) => (
            <OverrideRow key={`${rule.id}:${rule.category}`} rule={rule} />
          ))}
        </ul>
      )}
      {categories.data && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">The built-in list</summary>
          <p className="mt-2 text-muted-foreground">
            A site here covers its subdomains. Everything else is neutral.
          </p>
          <h3 className="mt-2 font-medium">Productive</h3>
          <p className="text-muted-foreground">{categories.data.presets.productive.join(", ")}</p>
          <h3 className="mt-2 font-medium">Distracting</h3>
          <p className="text-muted-foreground">{categories.data.presets.distracting.join(", ")}</p>
        </details>
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
      <Goals />
      <Overrides />
    </main>
  );
}
