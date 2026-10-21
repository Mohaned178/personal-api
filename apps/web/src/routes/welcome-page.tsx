import {
  allButSensitiveRules,
  chooseSitesRules,
  PRESET_DOMAINS_PER_RULE,
  RULE_PRESETS,
  type RuleDefinition,
  type RulePresetId,
  workSitesRules,
} from "@personal-api/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Integration, listIntegrations } from "@/lib/integrations";
import { createRule, listRules } from "@/lib/rules";
import { markWelcomeDone } from "@/lib/welcome";

/**
 * M8-02 setup wizard. Step 1 waits until a browser extension has reached the server (its
 * integration's `lastSeenAt` is set). Step 2 saves a preset from `packages/contracts` through the
 * normal `POST /v1/rules`, so the server validates every rule. Finishing or skipping sets the
 * "shown once" flag.
 */

const INTEGRATIONS_KEY = ["integrations"] as const;
const RULES_KEY = ["rules"] as const;
const POLL_MS = 3000;

const isConnected = (list: Integration[] | undefined) =>
  list?.some((i) => i.kind === "browser-extension" && i.status === "active" && i.lastSeenAt) ??
  false;

/** `https://www.Example.com/a` → `example.com`. Anything still invalid is refused by the preset. */
export function parseSites(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/^www\./, ""),
    )
    .filter((entry) => entry !== "");
}

function presetRules(id: RulePresetId, sites: string): RuleDefinition[] | null {
  if (id === "all-but-sensitive") return allButSensitiveRules();
  if (id === "work-sites") return workSitesRules();
  return chooseSitesRules(parseSites(sites));
}

function ConnectStep({ onNext }: { onNext: () => void }) {
  const list = useQuery({
    queryKey: INTEGRATIONS_KEY,
    queryFn: listIntegrations,
    refetchInterval: (query) => (isConnected(query.state.data) ? false : POLL_MS),
  });
  const connected = isConnected(list.data);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Step 1 of 2: connect this browser</h2>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Install the Personal API extension.</li>
        <li>
          Open its popup, enter this server's address{" "}
          <code className="rounded bg-muted px-1">{window.location.origin}</code> and press Connect.
        </li>
        <li>Confirm on the page that opens, then come back here.</li>
      </ol>
      <p role="status" className="text-sm">
        {connected ? "Browser connected." : "Waiting for the extension…"}
      </p>
      <Button type="button" onClick={onNext} disabled={!connected} className="self-start">
        Next
      </Button>
    </section>
  );
}

function PresetStep({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: listRules });
  const [preset, setPreset] = useState<RulePresetId>("all-but-sensitive");
  const [sites, setSites] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rules of the preset already saved, so a retry after a failure does not save them twice.
  const saved = useRef<{ preset: RulePresetId; sites: string; count: number } | null>(null);
  const existing = rules.data?.rules.length ?? 0;

  async function onSave() {
    const toSave = presetRules(preset, sites);
    if (toSave === null) {
      setError(`Enter 1 to ${PRESET_DOMAINS_PER_RULE} site names, such as example.com.`);
      return;
    }
    if (saved.current?.preset !== preset || saved.current.sites !== sites) {
      saved.current = { preset, sites, count: 0 };
    }
    const progress = saved.current;
    setBusy(true);
    setError(null);
    try {
      for (const rule of toSave.slice(progress.count)) {
        await createRule(rule);
        progress.count += 1;
      }
      await queryClient.invalidateQueries({ queryKey: RULES_KEY });
      onDone();
    } catch {
      setBusy(false);
      setError("Could not save the rules. Try again.");
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Step 2 of 2: choose what to collect</h2>
      {existing > 0 && (
        <p className="text-sm text-muted-foreground">
          You already have {existing} {existing === 1 ? "rule" : "rules"}. A preset adds to them.
        </p>
      )}
      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="sr-only">Preset</legend>
        {RULE_PRESETS.map((p) => (
          <label key={p.id} className="flex gap-2 rounded-md border p-3 text-sm">
            <input
              type="radio"
              name="preset"
              value={p.id}
              checked={preset === p.id}
              onChange={() => setPreset(p.id)}
            />
            <span>
              <span className="font-medium">{p.title}</span>
              <span className="block text-muted-foreground">{p.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {preset === "choose-sites" && (
        <label className="flex flex-col gap-1 text-sm">
          Your sites, separated by commas or new lines
          <textarea
            className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="example.com, news.example.org"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            disabled={busy}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="button" onClick={() => void onSave()} disabled={busy} className="self-start">
        Save and finish
      </Button>
    </section>
  );
}

export function WelcomePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);

  function finish() {
    markWelcomeDone();
    void navigate({ to: "/" });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Personal API</h1>
        <p className="text-sm text-muted-foreground">
          Two steps: connect your browser, then pick what it may collect. Nothing is collected until
          you do.
        </p>
      </div>
      {step === 1 ? <ConnectStep onNext={() => setStep(2)} /> : <PresetStep onDone={finish} />}
      <Button type="button" variant="ghost" onClick={finish} className="self-start">
        Skip setup
      </Button>
    </main>
  );
}
