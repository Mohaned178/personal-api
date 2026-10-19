import { timeZoneSchema } from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSettings, getTimeZones, updateSettings } from "@/lib/settings";

const SETTINGS_KEY = ["settings"] as const;
const TIME_ZONES_KEY = ["settings", "time-zones"] as const;

function TimeZoneForm({ saved }: { saved: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(saved);
  const valid = timeZoneSchema.safeParse(draft).success;
  // Only suggestions: without the list the field still takes a typed name, and the server decides.
  const zones = useQuery({ queryKey: TIME_ZONES_KEY, queryFn: getTimeZones, staleTime: Infinity });
  const save = useMutation({
    mutationFn: async () => {
      await updateSettings({ timeZone: draft });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (valid) save.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor="time-zone" className="text-sm font-medium">
        Time zone
      </label>
      <p className="text-xs text-muted-foreground">
        Daily activity totals cut days in this zone, for example Europe/Berlin or America/New_York.
      </p>
      <div className="flex gap-2">
        <Input
          id="time-zone"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!valid}
          list="time-zones"
        />
        <datalist id="time-zones">
          {(zones.data ?? []).map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <Button type="submit" disabled={!valid || save.isPending || draft === saved}>
          Save
        </Button>
      </div>
      {!valid && <p className="text-sm text-destructive">Enter an IANA time zone.</p>}
      {save.isError && (
        <p className="text-sm text-destructive">
          Could not save the time zone. Pick one from the suggestions.
        </p>
      )}
      {save.isSuccess && draft === saved && <p className="text-sm">Saved.</p>}
    </form>
  );
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: getSettings });
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      {settings.isError && <p className="text-sm text-destructive">Could not load settings.</p>}
      {settings.data && (
        <TimeZoneForm key={settings.data.timeZone} saved={settings.data.timeZone} />
      )}
    </main>
  );
}
