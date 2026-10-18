// M4-06 rules sync: `GET /v1/ingest/config` with an ETag, on its own periodic alarm (plus at every
// background start and right after pairing).
//
// What a result means for capture (invariant 1, fail closed):
// - 200 with a config that passes the contract AND the engine's compiler: stored (bound to the
//   connection it was fetched for);
// - 304: the stored rules are still current (only asked for when they are valid);
// - a 200 that does not validate, or any other answer that says "this key cannot have the rules"
//   (401, 403, 404, 409 ...): the stored rules are removed, so nothing is collected until a valid
//   set arrives;
// - a network error, a timeout, 408/425/429 or a 5xx: the last valid rules stay. They were decided
//   by the user, the server re-applies the rules to everything anyway, and going dark on a flaky
//   network would only lose data.
// Nothing here logs: a response can hold domains, paths and rule names.

import { ingestConfigResponseSchema } from "@personal-api/contracts";
import type { Connection } from "../connect";
import { connectionOwner, sameQueueOwner } from "../gate-mirror";
import { FLUSH_REQUEST_TIMEOUT_MS } from "../queue/constants";
import {
  activeRules,
  compileConfig,
  parseStoredRules,
  RULES_STORAGE_KEY,
  type StoredRules,
} from "./active-rules";

/** Own periodic alarm, separate from the capture heartbeat, the flush retry and the server heartbeat. */
export const RULES_SYNC_ALARM_NAME = "pa-rules-sync";

/** A rule change reaches the extension within about this long. A 304 costs one small request. */
export const RULES_SYNC_PERIOD_MINUTES = 1;

export type RulesSyncStatus = "updated" | "unchanged" | "cleared" | "not_connected" | "failed";

export interface RulesSyncDeps {
  /** The stored connection, or `null` (nothing is requested). */
  getConnection(): Promise<Connection | null>;
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  fetch(url: string, init: RequestInit): Promise<Response>;
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  };
}

export interface RulesSync {
  /** One sync. NEVER rejects. Calls run one after another, so none overlaps another. */
  sync(): Promise<RulesSyncStatus>;
  /** Every background start: creates the periodic alarm if missing, then syncs once. Never rejects. */
  start(): Promise<void>;
  /** Syncs for `RULES_SYNC_ALARM_NAME` (returns the promise, for Firefox); `undefined` otherwise. */
  onAlarm(alarm: { name: string }): Promise<void> | undefined;
}

/** Answers that mean "try again later" and keep the rules we have. */
const isTransient = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/** Frees the connection of a response whose body is not read (best effort, never throws). */
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: freeing the connection only.
  }
}

export function createRulesSync(deps: RulesSyncDeps): RulesSync {
  async function clear(): Promise<RulesSyncStatus> {
    await deps.storage.remove(RULES_STORAGE_KEY);
    return "cleared";
  }

  async function run(): Promise<RulesSyncStatus> {
    try {
      const connection = await deps.getConnection();
      if (connection === null) return "not_connected";
      const owner = connectionOwner(connection);

      // Ask "has it changed?" only about rules that are valid and belong to this connection.
      const raw = (await deps.storage.get(RULES_STORAGE_KEY))[RULES_STORAGE_KEY];
      const current: StoredRules | null =
        activeRules(raw, connection) === null ? null : parseStoredRules(raw);
      const headers: Record<string, string> = {
        authorization: `Bearer ${connection.ingestKey}`,
        accept: "application/json",
      };
      if (current !== null && current.etag !== "") headers["if-none-match"] = current.etag;

      let response: Response;
      try {
        response = await deps.fetch(`${connection.serverOrigin}/v1/ingest/config`, {
          method: "GET",
          headers,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(FLUSH_REQUEST_TIMEOUT_MS),
        });
      } catch {
        return "failed";
      }

      if (response.status === 304 && current !== null) {
        discard(response);
        return "unchanged";
      }
      if (response.status !== 200) {
        discard(response);
        return isTransient(response.status) ? "failed" : await clear();
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return await clear();
      }
      const parsed = ingestConfigResponseSchema.safeParse(body);
      if (!parsed.success || compileConfig(parsed.data) === null) return await clear();

      // The user may have paired again while the request was out: these rules are for the old owner.
      const after = await deps.getConnection();
      if (after === null || !sameQueueOwner(connectionOwner(after), owner)) return "failed";

      const stored: StoredRules = {
        owner,
        etag: response.headers.get("etag") ?? "",
        config: parsed.data,
      };
      await deps.storage.set({ [RULES_STORAGE_KEY]: stored });
      return "updated";
    } catch {
      // Fail closed and silent. Rules that were stored stay as they were (a failed read or write
      // changed nothing), and the next alarm tries again.
      return "failed";
    }
  }

  let chain: Promise<unknown> = Promise.resolve();
  function sync(): Promise<RulesSyncStatus> {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  }

  async function start(): Promise<void> {
    try {
      const existing = await deps.alarms.get(RULES_SYNC_ALARM_NAME);
      if (!existing) {
        await deps.alarms.create(RULES_SYNC_ALARM_NAME, {
          periodInMinutes: RULES_SYNC_PERIOD_MINUTES,
        });
      }
    } catch {
      // Never rejects: the next background start tries again.
    }
    await sync();
  }

  function onAlarm(alarm: { name: string }): Promise<void> | undefined {
    if (alarm.name !== RULES_SYNC_ALARM_NAME) return undefined;
    return sync().then(() => undefined);
  }

  return { sync, start, onAlarm };
}
