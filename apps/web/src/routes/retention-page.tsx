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

/** A change that shortens retention waits here until the user confirms it. */
type Pending = { action: "save" | "clear"; from: number; to: number };

function PolicyRow({
  scope,
  target,
  label,
  saved,
  defaultDays,
}: {
  scope: RetentionScope;
  target: string;
  label: string;
  saved: number | undefined;
  defaultDays: number;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(saved === undefined ? "" : String(saved));
  const [pending, setPending] = useState<Pending | null>(null);
  const days = Number(draft);
  const valid = draft !== "" && retentionDaysSchema.safeParse(days).success;
  // What applies today: the saved policy, else the default.
  const current = saved ?? defaultDays;
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

  /** A shorter retention deletes events at the next purge, so it asks first. */
  function request(action: "save" | "clear", to: number) {
    if (to < current) setPending({ action, from: current, to });
    else if (action === "save") save.mutate();
    else clear.mutate();
  }

  function confirm() {
    if (pending?.action === "save") save.mutate();
    else clear.mutate();
    setPending(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (valid) request("save", days);
  }

  const id = `retention-${scope}-${target}`;
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="flex-1 truncate text-sm">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={RETENTION_MIN_DAYS}
        max={RETENTION_MAX_DAYS}
        placeholder={String(defaultDays)}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setPending(null);
        }}
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
        onClick={() => request("clear", defaultDays)}
      >
        Clear
      </Button>
      {pending && (
        <div role="alert" className="flex basis-full flex-wrap items-center gap-2 text-sm">
          <span>
            This shortens retention from {pending.from} to {pending.to} days. Events older than{" "}
            {pending.to} days are permanently deleted at the next hourly purge.
          </span>
          <Button type="button" variant="destructive" onClick={confirm}>
            Confirm
          </Button>
          <Button type="button" variant="outline" onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      )}
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
  // A revoked source keeps its policy (and its events) until the user removes it, so it is listed.
  const revokedWithPolicy = (integrations.data ?? []).filter(
    (i) => i.status === "revoked" && saved("source", i.id) !== undefined,
  );

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Retention</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      {policies.isError && <p className="text-sm text-destructive">Could not load retention.</p>}
      {policies.data && defaultDays !== undefined && (
        <>
          <p className="text-sm text-muted-foreground">
            Events are kept for {defaultDays} days unless a policy below says otherwise. A rule with
            a retention action wins, then the event type, then the source. A change also applies to
            events you already have; shortening it deletes older events at the next hourly purge.
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
                defaultDays={defaultDays}
              />
            ))}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">By source</h2>
            {sources.length === 0 && revokedWithPolicy.length === 0 && (
              <p className="text-sm text-muted-foreground">No active integrations.</p>
            )}
            {sources.map((integration) => (
              <PolicyRow
                key={`${integration.id}:${saved("source", integration.id) ?? ""}`}
                scope="source"
                target={integration.id}
                label={integration.name}
                saved={saved("source", integration.id)}
                defaultDays={defaultDays}
              />
            ))}
            {revokedWithPolicy.map((integration) => (
              <PolicyRow
                key={`${integration.id}:${saved("source", integration.id) ?? ""}`}
                scope="source"
                target={integration.id}
                label={`${integration.name} (revoked)`}
                saved={saved("source", integration.id)}
                defaultDays={defaultDays}
              />
            ))}
          </section>
        </>
      )}
    </main>
  );
}
