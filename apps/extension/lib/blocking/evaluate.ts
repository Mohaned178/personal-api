// M9-06 focus mode and schedules, the pure part: which blocks are on at a given moment, and which
// one covers a site. No storage, no browser API. Times of day are the device's local time (a
// schedule means "09:00 here"), read with the Date getters so a fixed clock gives the same answer in
// every time zone. Nothing here sees a URL: only the domain the caller already reduced.

import type { FocusSession, Schedule } from "@personal-api/contracts";
import { domainMatches } from "@personal-api/rules";

export interface ActiveBlock {
  /** The focus session id or the schedule id. The block page's address carries only this. */
  id: string;
  kind: "focus" | "schedule";
  /** `Focus session`, or the name the user gave the schedule. */
  name: string;
  patterns: readonly string[];
  /** When it ends, as the local `HH:MM` the block page shows. */
  until: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

const minutesOfDay = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** 0 = Monday … 6 = Sunday, the contract's weekday numbering. */
const weekday = (date: Date): number => (date.getDay() + 6) % 7;

/**
 * Whether a schedule blocks at `now`. The start is inclusive and the end exclusive. A schedule whose
 * end is earlier than its start crosses midnight: its late part belongs to the weekday it started on,
 * so `23:00` to `07:00` on Friday is still on at 06:59 on Saturday.
 */
export function scheduleActive(schedule: Schedule, now: Date): boolean {
  const time = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(schedule.start);
  const end = minutesOfDay(schedule.end);
  const today = weekday(now);
  if (start < end) return schedule.days.includes(today) && time >= start && time < end;
  if (time >= start) return schedule.days.includes(today);
  return time < end && schedule.days.includes((today + 6) % 7);
}

/** Every block that is on at `now`: the focus session until its end, and the schedules in their window. */
export function activeBlocks(
  focus: FocusSession | null,
  schedules: readonly Schedule[],
  now: number,
): ActiveBlock[] {
  const blocks: ActiveBlock[] = [];
  const endsAt = focus === null ? Number.NaN : Date.parse(focus.endsAt);
  if (focus !== null && Number.isFinite(endsAt) && now < endsAt) {
    const end = new Date(endsAt);
    blocks.push({
      id: focus.id,
      kind: "focus",
      name: "Focus session",
      patterns: focus.patterns,
      until: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
    });
  }
  const date = new Date(now);
  for (const schedule of schedules) {
    if (!schedule.enabled || !scheduleActive(schedule, date)) continue;
    blocks.push({
      id: schedule.id,
      kind: "schedule",
      name: schedule.name,
      patterns: schedule.patterns,
      until: schedule.end,
    });
  }
  return blocks;
}

/** The first block that covers `domain`, or null. A focus session comes before a schedule. */
export function blockingFor(blocks: readonly ActiveBlock[], domain: string): ActiveBlock | null {
  return (
    blocks.find((block) => block.patterns.some((pattern) => domainMatches(pattern, domain))) ?? null
  );
}
