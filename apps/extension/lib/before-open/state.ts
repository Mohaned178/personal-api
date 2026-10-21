// M9-05 "Pause before opening": what the device remembers.
// - `beforeOpen` in `browser.storage.local`: the sites the user picked and the length of the pause.
//   Written by the popup, read by the background and the pause page. Ids, domain patterns and a
//   number only.
// - `pa.beforeOpen.allowed.<tabId>` in `browser.storage.session`: a tab that pressed "Continue" on a
//   pick may stay on that site without another pause. The value is the pick id. One key per tab, so
//   the pause page (which writes it) and the background (which clears it) never overwrite each
//   other. Never a URL, a path or a domain: the page the user wanted is not stored anywhere.

import { domainPatternSchema } from "@personal-api/contracts";

export const BEFORE_OPEN_STORAGE_KEY = "beforeOpen";

export const PAUSE_SECONDS_MIN = 5;
export const PAUSE_SECONDS_MAX = 10;
export const PAUSE_SECONDS_DEFAULT = 5;
/** Most picked sites. Keeps the stored value small. */
export const PICKS_MAX = 50;

export interface PickedSite {
  /** Random id. The pause page's address carries only this. */
  id: string;
  /** `example.com` (that site only) or `*.example.com` (its subdomains), like a limit's pattern. */
  pattern: string;
}

export interface BeforeOpenConfig {
  seconds: number;
  sites: PickedSite[];
}

export const EMPTY_CONFIG: BeforeOpenConfig = { seconds: PAUSE_SECONDS_DEFAULT, sites: [] };

/** `storage.session` key of the tab's allowance. */
export const allowedKey = (tabId: number): string => `pa.beforeOpen.allowed.${tabId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPick(value: unknown): value is PickedSite {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.pattern === "string" &&
    domainPatternSchema.safeParse(value.pattern).success
  );
}

const isSeconds = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= PAUSE_SECONDS_MIN &&
  (value as number) <= PAUSE_SECONDS_MAX;

/** The stored config. Anything malformed is dropped: no picks means no pause. Never throws. */
export function parseConfig(value: unknown): BeforeOpenConfig {
  if (!isRecord(value)) return EMPTY_CONFIG;
  const sites = Array.isArray(value.sites) ? value.sites.filter(isPick).slice(0, PICKS_MAX) : [];
  return {
    seconds: isSeconds(value.seconds) ? value.seconds : PAUSE_SECONDS_DEFAULT,
    sites: sites.map(({ id, pattern }) => ({ id, pattern })),
  };
}

/** The slice of `browser.storage.local` the config uses. */
export interface ConfigStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readConfig(storage: Pick<ConfigStorage, "get">): Promise<BeforeOpenConfig> {
  try {
    return parseConfig((await storage.get(BEFORE_OPEN_STORAGE_KEY))[BEFORE_OPEN_STORAGE_KEY]);
  } catch {
    return EMPTY_CONFIG;
  }
}

export type AddResult = "added" | "exists" | "invalid" | "full";

/** Picks a site. `newId` is injected for tests. */
export async function addPick(
  storage: ConfigStorage,
  pattern: string,
  newId: () => string,
): Promise<AddResult> {
  const trimmed = pattern.trim().toLowerCase();
  if (!domainPatternSchema.safeParse(trimmed).success) return "invalid";
  const config = await readConfig(storage);
  if (config.sites.some((site) => site.pattern === trimmed)) return "exists";
  if (config.sites.length >= PICKS_MAX) return "full";
  await storage.set({
    [BEFORE_OPEN_STORAGE_KEY]: {
      ...config,
      sites: [...config.sites, { id: newId(), pattern: trimmed }],
    },
  });
  return "added";
}

export async function removePick(storage: ConfigStorage, id: string): Promise<void> {
  const config = await readConfig(storage);
  await storage.set({
    [BEFORE_OPEN_STORAGE_KEY]: { ...config, sites: config.sites.filter((site) => site.id !== id) },
  });
}

/** Out-of-range values are refused (returns false). */
export async function setSeconds(storage: ConfigStorage, seconds: number): Promise<boolean> {
  if (!isSeconds(seconds)) return false;
  const config = await readConfig(storage);
  await storage.set({ [BEFORE_OPEN_STORAGE_KEY]: { ...config, seconds } });
  return true;
}
