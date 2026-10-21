import {
  LIMIT_MAX_MINUTES,
  LIMIT_MIN_MINUTES,
  type Limit,
  limitSaveSchema,
} from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLimit, deleteLimit, LimitsError, listLimits, replaceLimit } from "@/lib/limits";

const LIMITS_KEY = ["limits"] as const;

const SITE_HELP = "Enter a site such as youtube.com or *.youtube.com.";
const MINUTES_HELP = `Enter between ${LIMIT_MIN_MINUTES} and ${LIMIT_MAX_MINUTES} minutes.`;
const TAKEN = "There is already a limit for that site. Change that one instead.";
const FAILED = "Could not save the limit.";

/** The message for a failed save, never repeating what the user typed. */
const messageFor = (error: unknown): string =>
  error instanceof LimitsError && error.code === "limit.pattern_taken" ? TAKEN : FAILED;

function LimitRow({ limit }: { limit: Limit }) {
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState(String(limit.minutes));
  const [strict, setStrict] = useState(limit.strict);
  const parsed = limitSaveSchema.safeParse({
    pattern: limit.pattern,
    minutes: minutes.trim() === "" ? Number.NaN : Number(minutes),
    strict,
  });
  const changed = minutes !== String(limit.minutes) || strict !== limit.strict;
  const refresh = () => queryClient.invalidateQueries({ queryKey: LIMITS_KEY });
  const save = useMutation({
    mutationFn: async () => {
      if (parsed.success) await replaceLimit(limit.id, parsed.data);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => deleteLimit(limit.id), onSuccess: refresh });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (parsed.success) save.mutate();
  }

  return (
    <li>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{limit.pattern}</span>
        <Input
          type="number"
          inputMode="numeric"
          min={LIMIT_MIN_MINUTES}
          max={LIMIT_MAX_MINUTES}
          aria-label={`Minutes per day for ${limit.pattern}`}
          aria-invalid={!parsed.success}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          className="w-24"
        />
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            aria-label={`Strict mode for ${limit.pattern}`}
            checked={strict}
            onChange={(e) => setStrict(e.target.checked)}
          />
          Strict
        </label>
        <Button
          type="submit"
          aria-label={`Save ${limit.pattern}`}
          disabled={!parsed.success || !changed || save.isPending}
        >
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-label={`Remove ${limit.pattern}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
        {(save.isError || remove.isError) && (
          <span role="alert" className="basis-full text-sm text-destructive">
            {FAILED}
          </span>
        )}
      </form>
    </li>
  );
}

function AddLimit() {
  const queryClient = useQueryClient();
  const [site, setSite] = useState("");
  const [minutes, setMinutes] = useState("");
  const [strict, setStrict] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: createLimit,
    onSuccess: async () => {
      setSite("");
      setMinutes("");
      setStrict(false);
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: LIMITS_KEY });
    },
    onError: (error) => setProblem(messageFor(error)),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = limitSaveSchema.safeParse({
      pattern: site.trim().toLowerCase(),
      minutes: minutes.trim() === "" ? Number.NaN : Number(minutes),
      strict,
    });
    if (!parsed.success) {
      const siteWrong = parsed.error.issues.some((issue) => issue.path[0] === "pattern");
      setProblem(siteWrong ? SITE_HELP : MINUTES_HELP);
      return;
    }
    setProblem(null);
    add.mutate(parsed.data);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <label htmlFor="limit-site">Site</label>
          <Input
            id="limit-site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="youtube.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="limit-minutes">Minutes per day</label>
          <Input
            id="limit-minutes"
            type="number"
            inputMode="numeric"
            min={LIMIT_MIN_MINUTES}
            max={LIMIT_MAX_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="30"
            className="w-32"
          />
        </div>
        <Button type="submit" disabled={add.isPending}>
          Add limit
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
        Strict mode (no extra time until midnight)
      </label>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}

export function LimitsPage() {
  const limits = useQuery({ queryKey: LIMITS_KEY, queryFn: listLimits });

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Daily limits</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Set how long you can spend on a site each day. The time is counted on your device by the
        browser extension, which tells you when 10 minutes are left and when the time is up, then
        moves the tab to a "Time's up" page. A limit counts only sites your rules collect, never
        private windows. Use <code>*.example.com</code> for every subdomain. Strict mode removes the
        "5 more minutes" button until midnight.
      </p>
      <AddLimit />
      <section className="flex flex-col gap-3" aria-label="Your limits">
        <h2 className="text-lg font-medium">Your limits</h2>
        {limits.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {limits.isError && <p className="text-sm text-destructive">Could not load limits.</p>}
        {limits.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No limits yet.</p>
        )}
        {limits.data && limits.data.length > 0 && (
          <ul className="flex flex-col gap-3">
            {limits.data.map((limit) => (
              <LimitRow key={`${limit.id}:${limit.minutes}:${limit.strict}`} limit={limit} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
