import {
  EVENT_TYPES,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type RetentionScope,
  retentionDaysSchema,
} from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listIntegrations } from "@/lib/integrations";
import { deleteRetention, getRetention, putRetention } from "@/lib/retention";

const RETENTION_KEY = ["retention"] as const;
const INTEGRATIONS_KEY = ["integrations"] as const;

function PolicyRow({
  scope,
  target,
  label,
  saved,
  fallback,
}: {
  scope: RetentionScope;
  target: string;
  label: string;
  saved: number | undefined;
  fallback: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(saved === undefined ? "" : String(saved));
  const days = Number(draft);
  const valid = draft !== "" && retentionDaysSchema.safeParse(days).success;
  const refresh = () => queryClient.invalidateQueries({ queryKey: RETENTION_KEY });
  const save = useMutation({
    mutationFn: () => putRetention(scope, target, days),
    onSuccess: refresh,
  });
  const clear = useMutation({
    mutationFn: async () => {
      await deleteRetention(scope, target);
      setDraft("");
    },
    onSuccess: refresh,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (valid) save.mutate();
  }

  const id = `retention-${scope}-${target}`;
  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <label htmlFor={id} className="flex-1 truncate text-sm">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={RETENTION_MIN_DAYS}
        max={RETENTION_MAX_DAYS}
        placeholder={fallback}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-invalid={draft !== "" && !valid}
        className="w-28"
      />
      <Button type="submit" disabled={!valid || save.isPending || draft === String(saved ?? "")}>
        Save
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={saved === undefined || clear.isPending}
        onClick={() => clear.mutate()}
      >
        Clear
      </Button>
      {(save.isError || clear.isError) && (
        <span role="alert" className="text-sm text-destructive">
          Could not save.
        </span>
      )}
    </form>
  );
}

export function RetentionPage() {
  const policies = useQuery({ queryKey: RETENTION_KEY, queryFn: getRetention });
  const integrations = useQuery({ queryKey: INTEGRATIONS_KEY, queryFn: listIntegrations });
  const saved = (scope: RetentionScope, target: string) =>
    policies.data?.policies.find((p) => p.scope === scope && p.target === target)?.days;
  const defaultDays = policies.data?.defaultDays;
  const sources = (integrations.data ?? []).filter((i) => i.status === "active");

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Retention</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      {policies.isError && <p className="text-sm text-destructive">Could not load retention.</p>}
      {policies.data && (
        <>
          <p className="text-sm text-muted-foreground">
            Events are kept for {defaultDays} days unless a policy below says otherwise. A rule with
            a retention action wins, then the event type, then the source. A change applies to
            events stored from now on.
          </p>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">By event type</h2>
            {[...EVENT_TYPES].sort().map((type) => (
              <PolicyRow
                key={`${type}:${saved("type", type) ?? ""}`}
                scope="type"
                target={type}
                label={type}
                saved={saved("type", type)}
                fallback={String(defaultDays)}
              />
            ))}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">By source</h2>
            {sources.length === 0 && (
              <p className="text-sm text-muted-foreground">No active integrations.</p>
            )}
            {sources.map((integration) => (
              <PolicyRow
                key={`${integration.id}:${saved("source", integration.id) ?? ""}`}
                scope="source"
                target={integration.id}
                label={integration.name}
                saved={saved("source", integration.id)}
                fallback={String(defaultDays)}
              />
            ))}
          </section>
        </>
      )}
    </main>
  );
}
