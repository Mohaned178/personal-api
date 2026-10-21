import {
  BLOCK_PATTERNS_MAX,
  FOCUS_MAX_MINUTES,
  FOCUS_MIN_MINUTES,
  focusStartSchema,
  SCHEDULES_PER_USER_MAX,
  type Schedule,
  scheduleSaveSchema,
} from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BlockingError,
  createSchedule,
  deleteSchedule,
  endFocus,
  getFocus,
  listSchedules,
  replaceSchedule,
  startFocus,
} from "@/lib/blocking";

const FOCUS_KEY = ["focus"] as const;
const SCHEDULES_KEY = ["schedules"] as const;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const SITES_HELP = `Enter up to ${BLOCK_PATTERNS_MAX} sites such as youtube.com or *.youtube.com, separated by commas.`;
const MINUTES_HELP = `Enter between ${FOCUS_MIN_MINUTES} and ${FOCUS_MAX_MINUTES} minutes.`;
const SCHEDULE_HELP =
  "Give it a name, at least one site and one day, and different start and end times.";
const FAILED = "Could not save. Try again.";
const CAP = `You can have at most ${SCHEDULES_PER_USER_MAX} schedules. Remove one first.`;

/** `youtube.com, *.reddit.com` into a list of patterns (lower case, no empty entries). */
const parseSites = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((site) => site.trim().toLowerCase())
    .filter((site) => site !== "");

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function FocusSection() {
  const queryClient = useQueryClient();
  const focus = useQuery({ queryKey: FOCUS_KEY, queryFn: getFocus, refetchInterval: 30_000 });
  const [sites, setSites] = useState("");
  const [minutes, setMinutes] = useState("45");
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: FOCUS_KEY });
  const start = useMutation({
    mutationFn: startFocus,
    onSuccess: async () => {
      setSites("");
      setProblem(null);
      await refresh();
    },
    onError: () => setProblem(FAILED),
  });
  const end = useMutation({ mutationFn: endFocus, onSuccess: refresh });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = focusStartSchema.safeParse({
      patterns: parseSites(sites),
      minutes: minutes.trim() === "" ? Number.NaN : Number(minutes),
    });
    if (!parsed.success) {
      const sitesWrong = parsed.error.issues.some((issue) => issue.path[0] === "patterns");
      setProblem(sitesWrong ? SITES_HELP : MINUTES_HELP);
      return;
    }
    setProblem(null);
    start.mutate(parsed.data);
  }

  const running = focus.data && Date.parse(focus.data.endsAt) > Date.now() ? focus.data : null;

  return (
    <section className="flex flex-col gap-3" aria-label="Focus mode">
      <h2 className="text-lg font-medium">Focus mode</h2>
      {focus.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {focus.isError && <p className="text-sm text-destructive">Could not load focus mode.</p>}
      {running && (
        <div className="flex flex-col gap-2 rounded-md border p-4" data-testid="focus-running">
          <p className="font-medium">Focus mode is on until {clock(running.endsAt)}</p>
          <p className="text-sm text-muted-foreground">Blocked: {running.patterns.join(", ")}</p>
          <div>
            <Button variant="outline" disabled={end.isPending} onClick={() => end.mutate()}>
              End focus session
            </Button>
          </div>
          {end.isError && (
            <p role="alert" className="text-sm text-destructive">
              {FAILED}
            </p>
          )}
        </div>
      )}
      {focus.isSuccess && !running && (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-1 flex-col gap-1 text-sm">
              <label htmlFor="focus-sites">Sites to block</label>
              <Input
                id="focus-sites"
                value={sites}
                onChange={(e) => setSites(e.target.value)}
                placeholder="youtube.com, *.reddit.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor="focus-minutes">Minutes</label>
              <Input
                id="focus-minutes"
                type="number"
                inputMode="numeric"
                min={FOCUS_MIN_MINUTES}
                max={FOCUS_MAX_MINUTES}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                className="w-28"
              />
            </div>
            <Button type="submit" disabled={start.isPending}>
              Start focus session
            </Button>
          </div>
          {problem !== null && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
  const toggle = useMutation({
    mutationFn: () => {
      const { id, ...rest } = schedule;
      return replaceSchedule(id, { ...rest, enabled: !schedule.enabled });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => deleteSchedule(schedule.id), onSuccess: refresh });
  const days = schedule.days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DAYS[d])
    .join(", ");

  return (
    <li className="flex flex-col gap-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{schedule.name}</span>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            aria-label={`Turn on ${schedule.name}`}
            checked={schedule.enabled}
            disabled={toggle.isPending}
            onChange={() => toggle.mutate()}
          />
          On
        </label>
        <Button
          type="button"
          variant="outline"
          aria-label={`Remove ${schedule.name}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {schedule.start} to {schedule.end} · {days}
      </p>
      <p className="text-sm text-muted-foreground">{schedule.patterns.join(", ")}</p>
      {(toggle.isError || remove.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {FAILED}
        </p>
      )}
    </li>
  );
}

function AddSchedule() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [sites, setSites] = useState("");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [problem, setProblem] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: createSchedule,
    onSuccess: async () => {
      setName("");
      setSites("");
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (error) =>
      setProblem(
        error instanceof BlockingError && error.code === "schedule.limit_reached" ? CAP : FAILED,
      ),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = scheduleSaveSchema.safeParse({
      name,
      patterns: parseSites(sites),
      days,
      start,
      end,
      enabled: true,
    });
    if (!parsed.success) {
      const sitesWrong = parsed.error.issues.some((issue) => issue.path[0] === "patterns");
      setProblem(sitesWrong ? SITES_HELP : SCHEDULE_HELP);
      return;
    }
    setProblem(null);
    add.mutate(parsed.data);
  }

  const toggleDay = (day: number) =>
    setDays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="schedule-name">Name</label>
          <Input
            id="schedule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Work hours"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <label htmlFor="schedule-sites">Sites to block</label>
          <Input
            id="schedule-sites"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            placeholder="youtube.com, *.reddit.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="mb-1">Days</legend>
        {DAYS.map((label, day) => (
          <label key={label} className="flex items-center gap-1">
            <input type="checkbox" checked={days.includes(day)} onChange={() => toggleDay(day)} />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="schedule-start">From</label>
          <Input
            id="schedule-start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-32"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="schedule-end">Until</label>
          <Input
            id="schedule-end"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-32"
          />
        </div>
        <Button type="submit" disabled={add.isPending}>
          Add schedule
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}

function SchedulesSection() {
  const schedules = useQuery({ queryKey: SCHEDULES_KEY, queryFn: listSchedules });
  return (
    <section className="flex flex-col gap-3" aria-label="Schedules">
      <h2 className="text-lg font-medium">Schedules</h2>
      <AddSchedule />
      {schedules.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {schedules.isError && <p className="text-sm text-destructive">Could not load schedules.</p>}
      {schedules.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No schedules yet.</p>
      )}
      {schedules.data && schedules.data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {schedules.data.map((schedule) => (
            <ScheduleRow key={`${schedule.id}:${schedule.enabled}`} schedule={schedule} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function FocusPage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Focus and schedules</h1>
        <Link to="/" className="text-sm underline">
          Home
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Block sites for a while. A focus session blocks the sites you pick for a number of minutes;
        a schedule blocks them on chosen weekdays between two times (an end earlier than the start
        runs past midnight). The browser extension enforces both on your device, within about a
        minute of a change, and moves a blocked tab to a page that says why. There is no "more
        minutes" button; end a focus session here. Times follow the clock of the device. Use{" "}
        <code>*.example.com</code> for every subdomain.
      </p>
      <FocusSection />
      <SchedulesSection />
    </main>
  );
}
