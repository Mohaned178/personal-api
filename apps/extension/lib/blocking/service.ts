// M9-06 focus mode and schedules on the device. The focus session and the enabled schedules come
// with the rules (`GET /v1/ingest/config`, like the daily limits); this decides which are on now and
// moves every tab on a covered site to the extension's "Time's up" page (no content script). There
// is no override: a focus session is ended from the dashboard, and a schedule ends by itself.
//
// Evaluated on its own periodic alarm (the browser's minimum period is 30 seconds) and when a tab
// navigates or is activated, so a block starts and ends within about half a minute. Everything
// reads what is already on the device and nothing is stored or logged: the tab is moved with the
// block id in the page address and the page the user came from stays in the tab's own history.
// Private windows are never touched. Blocks are only enforced while the stored rules are valid and
// belong to this connection.

import { CONNECTION_STORAGE_KEY, parseStoredConnection } from "../connect";
import { activeBlockConfig, RULES_STORAGE_KEY } from "../rules/active-rules";
import { sanitizeUrl } from "../sanitize-url";
import { type ActiveBlock, activeBlocks, blockingFor } from "./evaluate";

/** Own periodic alarm. The browser's minimum period is 30 seconds. */
export const BLOCKING_ALARM_NAME = "pa-blocking";
export const BLOCKING_PERIOD_MINUTES = 0.5;

/** The storage side the blocks use. Both keys are read in ONE call. */
export interface BlockingStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
}

/** The blocks that are on now. For the block page and the service. Never rejects. */
export async function readActiveBlocks(deps: {
  storage: BlockingStorage;
  now: () => number;
}): Promise<ActiveBlock[]> {
  try {
    const raw = await deps.storage.get([CONNECTION_STORAGE_KEY, RULES_STORAGE_KEY]);
    const { focus, schedules } = activeBlockConfig(
      raw[RULES_STORAGE_KEY],
      parseStoredConnection(raw[CONNECTION_STORAGE_KEY]),
    );
    return activeBlocks(focus, schedules, deps.now());
  } catch {
    return [];
  }
}

export interface BlockTab {
  id?: number;
  url?: string;
  /** Anything other than the boolean `false` is treated as private (fail closed). */
  incognito?: boolean;
}

export interface BlockingDeps {
  storage: BlockingStorage;
  now(): number;
  tabs: {
    query(queryInfo: Record<string, never>): Promise<BlockTab[]>;
    update(tabId: number, properties: { url: string }): Promise<unknown>;
  };
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  };
  /** The extension page a blocked tab is sent to. Carries the block kind and id and nothing else. */
  blockedUrl(block: ActiveBlock): string;
}

export interface BlockingService {
  /** One evaluation. NEVER rejects. Calls run one after another, so none overlaps another. */
  tick(): Promise<void>;
  /** Every background start: creates the periodic alarm if missing, then evaluates once. Never rejects. */
  start(): Promise<void>;
  /** Evaluates for `BLOCKING_ALARM_NAME` (returns the promise, for Firefox); `undefined` otherwise. */
  onAlarm(alarm: { name: string }): Promise<void> | undefined;
}

export function createBlockingService(deps: BlockingDeps): BlockingService {
  async function run(): Promise<void> {
    try {
      const blocks = await readActiveBlocks(deps);
      if (blocks.length === 0) return;
      const tabs = await deps.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined || tab.incognito !== false) continue;
        const page = sanitizeUrl(tab.url);
        if (page === null) continue;
        const block = blockingFor(blocks, page.domain);
        if (block === null) continue;
        try {
          await deps.tabs.update(tab.id, { url: deps.blockedUrl(block) });
        } catch {
          // The tab may be gone.
        }
      }
    } catch {
      // Fail silent: the next evaluation tries again, and a block that cannot be read blocks nothing.
    }
  }

  let chain: Promise<unknown> = Promise.resolve();
  function tick(): Promise<void> {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  }

  async function start(): Promise<void> {
    try {
      if (!(await deps.alarms.get(BLOCKING_ALARM_NAME))) {
        await deps.alarms.create(BLOCKING_ALARM_NAME, { periodInMinutes: BLOCKING_PERIOD_MINUTES });
      }
    } catch {
      // Never rejects: the next background start tries again.
    }
    await tick();
  }

  function onAlarm(alarm: { name: string }): Promise<void> | undefined {
    return alarm.name === BLOCKING_ALARM_NAME ? tick() : undefined;
  }

  return { tick, start, onAlarm };
}
