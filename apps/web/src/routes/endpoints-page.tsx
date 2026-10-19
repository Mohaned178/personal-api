import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createEndpoint,
  deleteEndpoint,
  type Endpoint,
  EndpointRequestError,
  listEndpoints,
  previewEndpoint,
  replaceEndpoint,
  rotateEndpointKey,
} from "@/lib/endpoints";

/**
 * The plaintext key lives in component state only: never in the query cache, storage or logs (the
 * create and rotate mutations resolve to nothing, so their cache never holds it). Closing the panel
 * drops it.
 */
interface NewKey {
  slug: string;
  key: string;
}

const ENDPOINTS_KEY = ["endpoints"] as const;
const PREVIEW_DELAY_MS = 400;

const TEMPLATE = JSON.stringify(
  {
    when: { type: ["browser.page_visited"] },
    window: { kind: "last_n_days", days: 7 },
    aggregate: "count_by_day",
  },
  null,
  2,
);

/** `PA_KEY` stands in when the key is no longer known (it is shown once). */
export function curlFor(slug: string, key?: string): string {
  return `curl -H "Authorization: Bearer ${key ?? "$PA_KEY"}" ${window.location.origin}/v1/me/${slug}`;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function KeyPanel({ secret, onClose }: { secret: NewKey; onClose: () => void }) {
  const curl = curlFor(secret.slug, secret.key);
  return (
    <section aria-label="Endpoint key" className="flex flex-col gap-2 rounded-md border p-4">
      <p className="text-sm">
        Key for <strong>{secret.slug}</strong>. Copy it now: it is shown once and cannot be
        retrieved later. It can only read this endpoint.
      </p>
      <code data-testid="endpoint-key" className="break-all font-mono text-sm">
        {secret.key}
      </code>
      <code data-testid="endpoint-curl" className="break-all font-mono text-xs">
        {curl}
      </code>
      <div className="flex gap-2">
        <CopyButton text={curl} label="Copy curl command" />
        <Button variant="outline" onClick={onClose}>
          I have copied it
        </Button>
      </div>
    </section>
  );
}

function PreviewPanel({ text }: { text: string }) {
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const parsed = parseJson(debounced);
  const preview = useQuery({
    queryKey: ["endpoint-preview", debounced],
    queryFn: () => previewEndpoint(parsed.ok ? parsed.value : null),
    enabled: parsed.ok,
    retry: false,
  });

  let body: React.ReactNode;
  if (!parsed.ok) body = <p className="text-sm text-muted-foreground">Waiting for valid JSON…</p>;
  else if (preview.isPending) body = <p className="text-sm text-muted-foreground">Running…</p>;
  else if (preview.isError) {
    const status = preview.error instanceof EndpointRequestError ? preview.error.status : 0;
    body = (
      <p role="alert" className="text-sm text-destructive">
        {status === 400
          ? "This definition is not valid. Check the fields, types and window."
          : status === 504
            ? "The query took too long (2 second limit)."
            : "Could not run the preview."}
      </p>
    );
  } else {
    body = (
      <>
        <pre
          data-testid="endpoint-preview"
          className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs"
        >
          {JSON.stringify(preview.data, null, 2)}
        </pre>
        {preview.data.truncated && (
          <p className="text-xs text-muted-foreground">Cut at the row limit.</p>
        )}
      </>
    );
  }
  return (
    <section aria-label="Live preview" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Live preview</h3>
      {body}
    </section>
  );
}

function EndpointForm({
  editing,
  onDone,
  onKey,
}: {
  editing: Endpoint | null;
  onDone: () => void;
  onKey: (key: NewKey) => void;
}) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [text, setText] = useState(
    editing ? JSON.stringify(editing.definition, null, 2) : TEMPLATE,
  );
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (input: { slug: string; enabled: boolean; definition: unknown }) => {
      // Typed loosely on purpose: the server validates the definition against the shared schema.
      const body = input as Parameters<typeof createEndpoint>[0];
      if (editing) {
        await replaceEndpoint(editing.id, body);
      } else {
        const res = await createEndpoint(body);
        onKey({ slug: res.endpoint.slug, key: res.key });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY });
      onDone();
    },
    onError: (error) => {
      setFormError(
        error instanceof EndpointRequestError && error.status === 409
          ? "You already have an endpoint with this slug, or you reached the limit."
          : "Could not save. Check the slug and the definition.",
      );
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseJson(text);
    if (!parsed.ok) {
      setFormError("The definition is not valid JSON.");
      return;
    }
    setFormError(null);
    save.mutate({ slug: slug.trim(), enabled, definition: parsed.value });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="font-medium">{editing ? `Edit ${editing.slug}` : "Create an endpoint"}</h2>
      <label htmlFor="endpoint-slug" className="flex flex-col gap-1 text-sm font-medium">
        Slug
        <Input
          id="endpoint-slug"
          value={slug}
          maxLength={40}
          placeholder="weekly-stats"
          onChange={(e) => setSlug(e.target.value)}
        />
        <span className="font-normal text-muted-foreground">
          Served at <code>/v1/me/{slug || "…"}</code>. Lowercase letters, digits and hyphens.
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <label htmlFor="endpoint-definition" className="flex flex-col gap-1 text-sm font-medium">
        Saved query (JSON)
        <textarea
          id="endpoint-definition"
          value={text}
          rows={12}
          spellCheck={false}
          className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
          onChange={(e) => setText(e.target.value)}
        />
        <span className="font-normal text-muted-foreground">
          Either <code>fields</code> (raw events) or <code>aggregate</code>. See
          docs/saved-queries.md.
        </span>
      </label>
      <PreviewPanel text={text} />
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {editing ? "Save changes" : "Create endpoint"}
        </Button>
        {editing && (
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function EndpointRow({
  endpoint,
  onEdit,
  onKey,
}: {
  endpoint: Endpoint;
  onEdit: () => void;
  onKey: (key: NewKey) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<"delete" | "rotate" | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY });
  const remove = useMutation({
    mutationFn: () => deleteEndpoint(endpoint.id),
    onSuccess: () => {
      setConfirming(null);
      void refresh();
    },
  });
  // Resolves to nothing: the new key goes straight to component state, never into the cache.
  const rotate = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await rotateEndpointKey(endpoint.id);
      onKey({ slug: res.endpoint.slug, key: res.key });
    },
    onSuccess: () => setConfirming(null),
  });
  const curl = curlFor(endpoint.slug);
  const failed = remove.isError || rotate.isError;
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-medium">{endpoint.slug}</span>
          <span className="text-xs text-muted-foreground">
            {endpoint.enabled ? "Enabled" : "Disabled"} ·{" "}
            {endpoint.definition.aggregate ?? "raw events"} · updated{" "}
            {new Date(endpoint.updatedAt).toLocaleString()}
          </span>
        </div>
        {!confirming && (
          <div className="flex gap-2">
            <Button variant="outline" aria-label={`Edit ${endpoint.slug}`} onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="outline"
              aria-label={`Rotate key of ${endpoint.slug}`}
              onClick={() => setConfirming("rotate")}
            >
              New key
            </Button>
            <Button
              variant="outline"
              aria-label={`Delete ${endpoint.slug}`}
              onClick={() => setConfirming("delete")}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <code className="break-all font-mono text-xs">{curl}</code>
        <CopyButton text={curl} label={`Copy curl command for ${endpoint.slug}`} />
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Confirm ${confirming} for ${endpoint.slug}`}
          className="flex flex-col gap-2"
        >
          <p className="text-sm">
            {confirming === "delete" ? (
              <>
                Delete <strong>{endpoint.slug}</strong>? Its keys are deleted too.
              </>
            ) : (
              <>
                Make a new key for <strong>{endpoint.slug}</strong>? The current key stops working
                immediately.
              </>
            )}
          </p>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              That did not work. Try again.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={remove.isPending || rotate.isPending}
              onClick={() => (confirming === "delete" ? remove.mutate() : rotate.mutate())}
            >
              {confirming === "delete" ? "Confirm delete" : "Confirm new key"}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function EndpointsPage() {
  const [secret, setSecret] = useState<NewKey | null>(null);
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const list = useQuery({ queryKey: ENDPOINTS_KEY, queryFn: listEndpoints });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Endpoints</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>

      {secret && <KeyPanel secret={secret} onClose={() => setSecret(null)} />}

      <EndpointForm
        key={editing?.id ?? "new"}
        editing={editing}
        onDone={() => setEditing(null)}
        onKey={setSecret}
      />

      {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load endpoints. Reload the page to try again.
        </p>
      )}
      {list.data && list.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No endpoints yet. Create one above to share a saved query behind its own key.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.data.map((endpoint) => (
            <EndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              onEdit={() => setEditing(endpoint)}
              onKey={setSecret}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
