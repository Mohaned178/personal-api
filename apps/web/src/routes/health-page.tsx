import type { DiagnosticsBucket, DiagnosticsIntegration } from "@personal-api/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getDiagnostics } from "@/lib/diagnostics";

const SERIES = [
  { key: "accepted", label: "Accepted", color: "bg-green-600" },
  { key: "duplicate", label: "Duplicate", color: "bg-sky-500" },
  { key: "dropped", label: "Dropped", color: "bg-amber-500" },
  { key: "rejected", label: "Rejected", color: "bg-red-600" },
] as const;

const total = (b: DiagnosticsBucket) => b.accepted + b.duplicate + b.dropped + b.rejected;

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "Never";
}

function formatAge(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function IntegrationCard({ integration }: { integration: DiagnosticsIntegration }) {
  const hb = integration.heartbeat;
  return (
    <li className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{integration.name}</span>
        <span className="text-xs text-muted-foreground">
          {integration.kind === "browser-extension" ? "Browser extension" : "HTTP"} ·{" "}
          {integration.status === "active" ? "Active" : "Revoked"}
        </span>
      </div>
      <span className="text-sm">Last seen: {formatTime(integration.lastSeenAt)}</span>
      {hb ? (
        <dl className="grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Queue depth</dt>
            <dd>{hb.queueDepth}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Oldest queued</dt>
            <dd>{formatAge(hb.oldestQueuedAgeMs)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Dropped by client</dt>
            <dd>{hb.droppedCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Version</dt>
            <dd>{hb.clientVersion}</dd>
          </div>
        </dl>
      ) : (
        <span className="text-sm text-muted-foreground">No heartbeat received yet.</span>
      )}
    </li>
  );
}

/** Stacked bars, one per hour, with the window totals as a legend (exact numbers, screen readers). */
function IngestionChart({ buckets }: { buckets: DiagnosticsBucket[] }) {
  const max = Math.max(1, ...buckets.map(total));
  const sums = SERIES.map((s) => ({
    ...s,
    sum: buckets.reduce((n, b) => n + b[s.key], 0),
  }));
  return (
    <section aria-label="Ingestion by hour" className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-4 text-sm">
        {sums.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block size-3 rounded-sm ${s.color}`} />
            <span>{s.label}:</span> <strong>{s.sum}</strong>
          </li>
        ))}
      </ul>
      <div
        role="img"
        aria-label={`Events per hour over the last ${buckets.length} hours`}
        className="flex h-40 items-end gap-0.5 rounded-md border p-2"
      >
        {buckets.map((b) => (
          <div
            key={b.bucket}
            title={`${new Date(b.bucket).toLocaleString()}: ${total(b)} events`}
            className="flex h-full flex-1 flex-col-reverse"
          >
            {SERIES.map((s) => (
              <div
                key={s.key}
                className={s.color}
                style={{ height: `${(b[s.key] / max) * 100}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function HealthPage() {
  const diagnostics = useQuery({ queryKey: ["diagnostics"], queryFn: () => getDiagnostics() });
  const data = diagnostics.data;
  const noTraffic = data ? data.ingestion.every((b) => total(b) === 0) : false;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>

      {diagnostics.isPending && <p role="status">Loading…</p>}
      {diagnostics.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load diagnostics. Reload the page to try again.
        </p>
      )}

      {data && (
        <>
          <section aria-label="Sources" className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Sources</h2>
            {data.integrations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sources yet. Add one on the Integrations page to see its health here.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.integrations.map((i) => (
                  <IntegrationCard key={i.id} integration={i} />
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Ingestion, last {data.ingestion.length} hours</h2>
            {noTraffic && (
              <p className="text-sm text-muted-foreground">
                No events received in this window. Charts fill in as sources send events.
              </p>
            )}
            <IngestionChart buckets={data.ingestion} />
          </section>
        </>
      )}
    </main>
  );
}
