import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createExtensionIntegration, issuePairingCode } from "@/lib/integrations";

/**
 * M8-01 one-click connect (ADR 0003). The extension opens `/connect-extension` in a tab it
 * remembers. Nothing is created until the user confirms here, so a link from another site cannot
 * create integrations on its own. The confirm creates a `browser-extension` integration and a
 * pairing code, then moves this tab to `/connect-extension/done#code=<code>`: the fragment never
 * reaches the server, and the extension's background reads it from this tab only.
 *
 * The code is never in React Query (plain calls, no mutation) and never logged.
 */

/** The name the new integration gets, from the browser family (shown on the Integrations page). */
function browserName(userAgent: string): string {
  if (/\bEdg\//.test(userAgent)) return "Edge";
  if (/\bFirefox\//.test(userAgent)) return "Firefox";
  if (/\bChrome\//.test(userAgent)) return "Chrome";
  return "Browser extension";
}

export function ConnectExtensionPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      const integration = await createExtensionIntegration(browserName(navigator.userAgent));
      const { pairingCode } = await issuePairingCode(integration.id);
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
      await navigate({ to: "/connect-extension/done", hash: `code=${pairingCode}`, replace: true });
    } catch {
      setBusy(false);
      setError("Could not connect the browser. Try again.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Connect this browser</h1>
      <p className="text-sm text-muted-foreground">
        The Personal API extension asked to connect to your account. It will send only the sites
        your rules allow. Continue only if you opened this from the extension.
      </p>
      <Button id="connect-browser" type="button" onClick={() => void onConnect()} disabled={busy}>
        Connect this browser
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Link to="/" className="text-sm text-muted-foreground underline">
        Cancel
      </Link>
    </main>
  );
}

const CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function ConnectExtensionDonePage() {
  const { hash } = useLocation();
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code");
  const valid = code !== null && CODE_PATTERN.test(code);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Connecting…</h1>
      {valid ? (
        <>
          <p className="text-sm text-muted-foreground">
            The extension is finishing the connection. This tab closes by itself.
          </p>
          <p className="text-sm text-muted-foreground">
            If it stays open, enter this pairing code in the extension instead (valid for 10
            minutes):
          </p>
          <code className="rounded bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider">
            {code}
          </code>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This page has no pairing code. Start again from the extension.
        </p>
      )}
    </main>
  );
}
