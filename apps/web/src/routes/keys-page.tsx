import { READ_SCOPES } from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listIntegrations } from "@/lib/integrations";
import { createReadKey, listReadKeys, type ReadKey, revokeReadKey } from "@/lib/keys";

/**
 * The plaintext key lives in component state only: never in the query cache, storage or logs (the
 * create mutation resolves to nothing, so its cache never holds it). Closing the panel drops it.
 */
interface NewKey {
  name: string | null;
  key: string;
}

const KEYS_KEY = ["read-keys"] as const;
const INTEGRATIONS_KEY = ["integrations"] as const;

const SCOPE_HINTS: Record<(typeof READ_SCOPES)[number], string> = {
  "events:read": "Read raw events",
  "activity:read": "Read daily and per-domain activity totals",
};

function KeyPanel({ secret, onClose }: { secret: NewKey; onClose: () => void }) {
  return (
    <section aria-label="Read key" className="flex flex-col gap-2 rounded-md border p-4">
      <p className="text-sm">
        Read key{secret.name ? ` for ${secret.name}` : ""}. Copy it now: it is shown once and cannot
        be retrieved later.
      </p>
      <code data-testid="read-key" className="break-all font-mono text-sm">
        {secret.key}
      </code>
      <div>
        <Button variant="outline" onClick={onClose}>
          I have copied it
        </Button>
      </div>
    </section>
  );
}

function KeyRow({
  readKey,
  sourceNames,
  onRevoked,
}: {
  readKey: ReadKey;
  sourceNames: Map<string, string>;
  onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeReadKey(readKey.id),
    onSuccess: () => {
      setConfirming(false);
      onRevoked();
    },
  });
  const active = readKey.revokedAt === null;
  const label = readKey.name ?? `${readKey.prefix}…`;
  const { restriction } = readKey;
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-medium">{label}</span>
          {readKey.name && (
            <span className="font-mono text-xs text-muted-foreground">{readKey.prefix}…</span>
          )}
          <span className="text-xs text-muted-foreground">
            {readKey.scopes.join(", ")} · {active ? "Active" : "Revoked"}
          </span>
          {restriction?.sources && (
            <span className="text-xs text-muted-foreground">
              Only sources:{" "}
              {restriction.sources.map((id) => sourceNames.get(id) ?? "Unknown source").join(", ")}
            </span>
          )}
          {restriction?.types && (
            <span className="text-xs text-muted-foreground">
              Only event types: {restriction.types.join(", ")}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            Last used:{" "}
            {readKey.lastUsedAt ? new Date(readKey.lastUsedAt).toLocaleString() : "never"}
          </span>
        </div>
        {active && !confirming && (
          <Button
            variant="outline"
            aria-label={`Revoke ${label}`}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Confirm revoking ${label}`}
          className="flex flex-col gap-2"
        >
          <p className="text-sm">
            Revoke <strong>{label}</strong>? Anything using it stops working immediately.
          </p>
          {revoke.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not revoke. Try again.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              Confirm revoke
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function KeysPage() {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<NewKey | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const list = useQuery({ queryKey: KEYS_KEY, queryFn: listReadKeys });
  const integrations = useQuery({ queryKey: INTEGRATIONS_KEY, queryFn: listIntegrations });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEYS_KEY });

  const sourceNames = new Map((integrations.data ?? []).map((i) => [i.id, i.name]));
  const activeIntegrations = (integrations.data ?? []).filter((i) => i.status === "active");

  // The mutation resolves to nothing: the key goes straight to component state, so the mutation
  // cache (which keeps a mutation's result until it is collected) never holds it.
  const create = useMutation({
    mutationFn: async (body: Parameters<typeof createReadKey>[0]): Promise<void> => {
      const res = await createReadKey(body);
      setSecret({ name: res.readKey.name, key: res.key });
    },
    onSuccess: () => void refresh(),
  });

  function toggle(list: string[], value: string, on: boolean): string[] {
    return on ? [...list, value] : list.filter((v) => v !== value);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const types = String(data.get("types") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (scopes.length === 0) {
      setFormError("Choose at least one scope.");
      return;
    }
    setFormError(null);
    const restriction = {
      ...(sources.length > 0 && { sources }),
      ...(types.length > 0 && { types }),
    };
    create.mutate(
      {
        ...(name && { name }),
        scopes: READ_SCOPES.filter((s) => scopes.includes(s)),
        ...(Object.keys(restriction).length > 0 && { restriction }),
      },
      {
        onSuccess: () => {
          form.reset();
          setScopes([]);
          setSources([]);
        },
      },
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Read keys</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>

      {secret && <KeyPanel secret={secret} onClose={() => setSecret(null)} />}

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="font-medium">Create a read key</h2>
        <p className="text-sm text-muted-foreground">
          A read key can only read your data, within the scopes you give it.
        </p>
        <label htmlFor="key-name" className="flex flex-col gap-1 text-sm font-medium">
          Name (optional)
          <Input id="key-name" name="name" type="text" maxLength={80} />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-medium">Scopes</legend>
          {READ_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) => setScopes((s) => toggle(s, scope, e.target.checked))}
              />
              <span>
                <code>{scope}</code>
                <span className="text-muted-foreground"> — {SCOPE_HINTS[scope]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-medium">Only these sources (optional)</legend>
          {activeIntegrations.length === 0 && (
            <p className="text-muted-foreground">No active integrations to choose from.</p>
          )}
          {activeIntegrations.map((i) => (
            <label key={i.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sources.includes(i.id)}
                onChange={(e) => setSources((s) => toggle(s, i.id, e.target.checked))}
              />
              {i.name}
            </label>
          ))}
        </fieldset>
        <label htmlFor="key-types" className="flex flex-col gap-1 text-sm font-medium">
          Only these event types (optional)
          <Input
            id="key-types"
            name="types"
            type="text"
            placeholder="browser.*, browser.page_visited"
          />
        </label>
        {(formError || create.isError) && (
          <p role="alert" className="text-sm text-destructive">
            {formError ??
              "Could not create the key. Check the scopes and event types and try again."}
          </p>
        )}
        <div>
          <Button type="submit" disabled={create.isPending}>
            Create key
          </Button>
        </div>
      </form>

      {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load read keys. Reload the page to try again.
        </p>
      )}
      {list.data && list.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No read keys yet. Create one above to read your data from a script or another app.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.data.map((k) => (
            <KeyRow
              key={k.id}
              readKey={k}
              sourceNames={sourceNames}
              onRevoked={() => void refresh()}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
