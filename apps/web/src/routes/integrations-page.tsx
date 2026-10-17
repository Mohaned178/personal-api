import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createExtensionIntegration,
  createHttpIntegration,
  type Integration,
  issuePairingCode,
  listIntegrations,
  revokeIntegration,
} from "@/lib/integrations";

/**
 * Secrets (an ingest key, a pairing code) live in component state only: never in the query cache,
 * storage or logs. Closing the panel drops them for good.
 */
type Secret =
  | { type: "key"; integrationName: string; key: string }
  | {
      type: "code";
      integrationId: string;
      integrationName: string;
      code: string;
      expiresAt: number;
    };
type CodeSecret = Extract<Secret, { type: "code" }>;
type KeySecret = Extract<Secret, { type: "key" }>;

const INTEGRATIONS_KEY = ["integrations"] as const;

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function codeSecret(i: Pick<Integration, "id" | "name">): Promise<CodeSecret> {
  const res = await issuePairingCode(i.id);
  return {
    type: "code",
    integrationId: i.id,
    integrationName: i.name,
    code: res.pairingCode,
    expiresAt: Date.parse(res.expiresAt),
  };
}

function PairingCodePanel({
  secret,
  onNewCode,
  onClose,
  busy,
}: {
  secret: CodeSecret;
  onNewCode: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = secret.expiresAt - now;
  const expired = remaining <= 0;
  return (
    <section aria-label="Pairing code" className="flex flex-col gap-2 rounded-md border p-4">
      <p className="text-sm">
        Enter this code in the extension popup for <strong>{secret.integrationName}</strong>.
      </p>
      {expired ? (
        <p role="status" className="text-sm text-destructive">
          This code has expired.
        </p>
      ) : (
        <>
          <code data-testid="pairing-code" className="font-mono text-lg tracking-wider">
            {secret.code}
          </code>
          <p role="timer" className="text-sm text-muted-foreground">
            Expires in {formatCountdown(remaining)}
          </p>
        </>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onNewCode} disabled={busy}>
          New code
        </Button>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    </section>
  );
}

function KeyPanel({ secret, onClose }: { secret: KeySecret; onClose: () => void }) {
  return (
    <section aria-label="Ingest key" className="flex flex-col gap-2 rounded-md border p-4">
      <p className="text-sm">
        Ingest key for <strong>{secret.integrationName}</strong>. Copy it now: it is shown once and
        cannot be retrieved later.
      </p>
      <code data-testid="ingest-key" className="break-all font-mono text-sm">
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

function IntegrationRow({
  integration,
  onPair,
  onRevoked,
}: {
  integration: Integration;
  onPair: (i: Integration) => void;
  onRevoked: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeIntegration(integration.id),
    onSuccess: () => {
      setConfirming(false);
      onRevoked(integration.id);
    },
  });
  const active = integration.status === "active";
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-medium">{integration.name}</span>
          <span className="text-xs text-muted-foreground">
            {integration.kind === "http" ? "HTTP" : "Browser extension"} ·{" "}
            {active ? "Active" : "Revoked"}
          </span>
        </div>
        {active && !confirming && (
          <div className="flex gap-2">
            {integration.kind === "browser-extension" && (
              <Button
                variant="outline"
                aria-label={`Pairing code for ${integration.name}`}
                onClick={() => onPair(integration)}
              >
                Pairing code
              </Button>
            )}
            <Button
              variant="outline"
              aria-label={`Revoke ${integration.name}`}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Confirm revoking ${integration.name}`}
          className="flex flex-col gap-2"
        >
          <p className="text-sm">
            Revoke <strong>{integration.name}</strong>? Its keys stop working immediately.
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

export function IntegrationsPage() {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<Secret | null>(null);
  const [kind, setKind] = useState<"browser-extension" | "http">("browser-extension");
  const [formError, setFormError] = useState<string | null>(null);

  const list = useQuery({ queryKey: INTEGRATIONS_KEY, queryFn: listIntegrations });
  const refresh = () => queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });

  const code = useMutation({ mutationFn: codeSecret, onSuccess: setSecret });

  const create = useMutation({
    mutationFn: async ({
      name,
      kind,
    }: {
      name: string;
      kind: "browser-extension" | "http";
    }): Promise<Secret> => {
      if (kind === "http") {
        const res = await createHttpIntegration(name);
        return { type: "key", integrationName: res.integration.name, key: res.ingestKey.key };
      }
      return codeSecret(await createExtensionIntegration(name));
    },
    onSuccess: (s) => {
      setSecret(s);
      void refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) {
      setFormError("Enter a name.");
      return;
    }
    setFormError(null);
    create.mutate({ name, kind }, { onSuccess: () => form.reset() });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>

      {secret?.type === "key" && <KeyPanel secret={secret} onClose={() => setSecret(null)} />}
      {secret?.type === "code" && (
        <PairingCodePanel
          secret={secret}
          busy={code.isPending}
          onNewCode={() => code.mutate({ id: secret.integrationId, name: secret.integrationName })}
          onClose={() => setSecret(null)}
        />
      )}

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="font-medium">Add an integration</h2>
        <label htmlFor="integration-name" className="flex flex-col gap-1 text-sm font-medium">
          Name
          <Input id="integration-name" name="name" type="text" maxLength={80} />
        </label>
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Type</legend>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="kind"
              checked={kind === "browser-extension"}
              onChange={() => setKind("browser-extension")}
            />
            Browser extension
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="kind"
              checked={kind === "http"}
              onChange={() => setKind("http")}
            />
            HTTP
          </label>
        </fieldset>
        {(formError || create.isError) && (
          <p role="alert" className="text-sm text-destructive">
            {formError ?? "Could not add the integration. Check the name and try again."}
          </p>
        )}
        <div>
          <Button type="submit" disabled={create.isPending}>
            Add integration
          </Button>
        </div>
      </form>

      {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load integrations. Reload the page to try again.
        </p>
      )}
      {list.data && list.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No integrations yet. Add a browser extension or an HTTP source above to start collecting.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.data.map((i) => (
            <IntegrationRow
              key={i.id}
              integration={i}
              onPair={(x) => code.mutate({ id: x.id, name: x.name })}
              onRevoked={(id) => {
                // A revoked integration's pairing code must not stay on screen.
                setSecret((s) => (s?.type === "code" && s.integrationId === id ? null : s));
                void refresh();
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
