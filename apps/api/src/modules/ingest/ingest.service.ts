import { Inject, Injectable } from "@nestjs/common";
import {
  eventIdSchema,
  type HeartbeatRequest,
  INGEST_BATCH_INVALID_CODE,
  type IngestBatchResponse,
  type IngestConfigResponse,
  type IngestErrorCode,
  type IngestItemResult,
  ingestBatchRequestSchema,
  isPlainObject,
  parseEvent,
  RETENTION_DEFAULT_DAYS,
  resolveRetentionDays,
  toContractIssues,
} from "@personal-api/contracts";
import { canTrustCollected, evaluate } from "@personal-api/rules";
import type { z } from "zod";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { FocusService } from "../focus/focus.service";
import { INVALID_KEY_CODE } from "../keys/ingest-key.guard";
import { LimitsService } from "../limits/limits.service";
import { RetentionService } from "../retention/retention.service";
import { type LoadedRuleSet, RuleSetProvider } from "../rules/rule-set.provider";
import { SchedulesService } from "../schedules/schedules.service";
import { etagOf } from "./etag";
import {
  type Caller,
  type IngestionCounts,
  IngestRepository,
  type NewEvent,
} from "./ingest.repository";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The age limit when no policy or rule says otherwise. An event whose `occurredAt` is further than
 * its own retention (`resolveRetentionDays`) before the server clock is rejected with
 * `ingest.occurred_at_too_old` (inclusive: exactly that old is accepted), because it would
 * already be expired.
 */
export const INGEST_MAX_EVENT_AGE_MS = RETENTION_DEFAULT_DAYS * DAY_MS;

/**
 * Events whose `occurredAt` is further than this ahead of the server clock are clamped to
 * `receivedAt`, and the original is kept in `client_occurred_at` (exactly 5 minutes ahead is kept
 * as sent).
 */
export const INGEST_MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;

/** The start of `at`'s UTC hour: the `ingestion_log` bucket. */
export function hourBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Who sent the batch and which rules apply to it. All of it comes from the server, never the body. */
export interface Enforcement {
  caller: Caller;
  rules: LoadedRuleSet;
  /** The user's retention policies: days by event type, and for the sending integration. */
  retention?: { type: ReadonlyMap<string, number>; sourceDays: number | null };
}

/** What happens to one item of a batch, decided before anything is stored. */
export type ItemPlan =
  | { kind: "rejected"; code: IngestErrorCode; id?: string }
  /** A rule, or the default policy, said no. Carries who decided, never the event (invariant 2). */
  | { kind: "dropped"; id: string; decidedBy: string }
  /** The first valid occurrence of its id in the batch: inserted unless already stored. */
  | { kind: "store"; event: NewEvent }
  /** A later valid occurrence of an id stored earlier in the same batch: always a duplicate. */
  | { kind: "repeat"; id: string };

/**
 * Decides each item on its own, in request order. `parseEvent()` runs first, so its code wins
 * over the age check. The age check uses the client's original `occurredAt`, so clamping never
 * rescues an old event. Then the user's rules decide (`enforce`). Only the rules' output reaches a
 * `store` plan, never the raw input, so redact and coarsen hold.
 */
export function planBatch(
  items: readonly unknown[],
  receivedAt: Date,
  enforcement: Enforcement,
): ItemPlan[] {
  const now = receivedAt.getTime();
  const seen = new Set<string>();
  return items.map((item): ItemPlan => {
    const parsed = parseEvent(item);
    if (!parsed.ok) return rejected(parsed.code, eventIdOf(item));
    const { event } = parsed;
    const occurredAt = Date.parse(event.occurredAt);
    // The contract only accepts parseable date-times; this keeps one bad item from failing the batch.
    if (!Number.isFinite(occurredAt)) return rejected("ingest.envelope_invalid", event.id);
    const age = now - occurredAt;
    const policy = {
      type: enforcement.retention?.type.get(event.type) ?? null,
      source: enforcement.retention?.sourceDays ?? null,
    };
    let decided: ReturnType<typeof enforce> | undefined;
    if (age > resolveRetentionDays({ rule: null, ...policy }) * DAY_MS) {
      // Only a `set_retention` rule can still keep an event this old.
      decided = enforce(event, enforcement);
      const ruleDays = decided.kind === "allow" ? decided.result.retentionDays : null;
      if (ruleDays === null || age > ruleDays * DAY_MS) {
        return rejected("ingest.occurred_at_too_old", event.id);
      }
    }
    if (seen.has(event.id)) return { kind: "repeat", id: event.id };
    decided ??= enforce(event, enforcement);
    if (decided.kind !== "allow") return decided.plan;
    const days = resolveRetentionDays({ rule: decided.result.retentionDays, ...policy });
    if (age > days * DAY_MS) return rejected("ingest.occurred_at_too_old", event.id);
    seen.add(event.id);
    const clamped = occurredAt - now > INGEST_MAX_FUTURE_SKEW_MS;
    const { result } = decided;
    return {
      kind: "store",
      event: {
        clientEventId: event.id,
        type: event.type,
        typeVersion: event.typeVersion,
        occurredAt: new Date(clamped ? now : occurredAt),
        clientOccurredAt: clamped ? new Date(occurredAt) : null,
        receivedAt: new Date(now),
        data: result.event.data,
        tags: result.tags,
        trace: result.trace,
        expiresAt: new Date(now + days * DAY_MS),
      },
    };
  });
}

type Allowed = Extract<ReturnType<typeof evaluate>, { decision: "allow" }>;

/**
 * Runs the user's rules on one validated event (collect, then process). Anything but a clear
 * `allow` keeps the event out (invariant 1): `drop` is counted, `error` and a rule set that could
 * not be loaded are `ingest.rule_error`.
 *
 * `collected` (docs/rule-format.md, open item 1) is set only when the DB says the sender is a
 * browser extension, the event names the server's current rule-set version, that version has
 * collect rules, and `canTrustCollected` says the rules need it: an `allow` rule reads a field that
 * a collect transform rewrites. The extension then already applied this version's rules to the
 * event, so an event that no rule decides is not left to the default policy (it may have been
 * rewritten out of its own rule's reach). Every other event (a user with no rules, a stale
 * version, an `http` sender, rules that rewrite nothing an `allow` rule reads) gets the full
 * evaluation and the default policy. `keepQuery` is ignored: events have no place for a query
 * string yet, so it stays stripped (open item 2).
 */
function enforce(
  event: { id: string; meta?: { ruleSetVersion: number } | undefined },
  { caller, rules }: Enforcement,
): { kind: "allow"; result: Allowed } | { kind: "stop"; plan: ItemPlan } {
  const { compiled } = rules;
  if (compiled === null) return { kind: "stop", plan: rejected("ingest.rule_error", event.id) };
  const collected =
    caller.kind === "browser-extension" &&
    compiled.version >= 1 &&
    compiled.collect.length > 0 &&
    event.meta?.ruleSetVersion === compiled.version &&
    canTrustCollected(compiled);
  const result = evaluate(event, compiled, caller.defaultPolicy, {
    source: caller.kind,
    collected,
  });
  if (result.decision === "error") {
    return { kind: "stop", plan: rejected("ingest.rule_error", event.id) };
  }
  if (result.decision === "drop") {
    return {
      kind: "stop",
      plan: { kind: "dropped", id: event.id, decidedBy: result.trace.decidedBy },
    };
  }
  return { kind: "allow", result };
}

/**
 * Per-item results in request order. Whether a stored item is `accepted` or `duplicate` comes
 * only from `stored`, the ids the insert returned. A `dropped` item carries its id and nothing else.
 */
export function toResults(
  plan: readonly ItemPlan[],
  stored: ReadonlySet<string>,
): IngestItemResult[] {
  return plan.map((item): IngestItemResult => {
    if (item.kind === "rejected") {
      return item.id === undefined
        ? { status: "rejected", code: item.code }
        : { id: item.id, status: "rejected", code: item.code };
    }
    if (item.kind === "dropped") return { id: item.id, status: "dropped" };
    if (item.kind === "repeat") return { id: item.id, status: "duplicate" };
    const id = item.event.clientEventId;
    return { id, status: stored.has(id) ? "accepted" : "duplicate" };
  });
}

/**
 * The `ingestion_log` counters for a plan and its results (same length, same order). Rejected
 * items are counted by error code, dropped ones by the rule that decided (its id, or
 * `default_policy`): never by anything from the event (invariant 2).
 */
export function countResults(
  plan: readonly ItemPlan[],
  results: readonly IngestItemResult[],
): IngestionCounts {
  const counts: IngestionCounts = {
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    rejected: 0,
    byReason: {},
  };
  const bump = (reason: string) => {
    counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  };
  results.forEach((result, index) => {
    counts[result.status] += 1;
    if (result.status === "rejected") bump(result.code);
    const item = plan[index];
    if (result.status === "dropped" && item?.kind === "dropped") bump(item.decidedBy);
  });
  return counts;
}

/** integrations.last_seen_at is written at most once per this interval per integration. */
export const LAST_SEEN_UPDATE_INTERVAL_MS = 60_000;

@Injectable()
export class IngestService {
  constructor(
    private readonly repository: IngestRepository,
    private readonly ruleSets: RuleSetProvider,
    private readonly retention: RetentionService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly limits: LimitsService,
    private readonly focus: FocusService,
    private readonly schedules: SchedulesService,
  ) {}

  /**
   * `POST /v1/ingest/events`. A body that fails the batch shape is one 400 problem+json
   * (`ingest.batch_invalid`) and stores nothing. Otherwise each item gets its own result, valid
   * events are stored, and the hourly counters are updated, all in one transaction. `userId` and
   * `integrationId` and `keyId` come from the ingest AuthContext only (invariant 4). If the key was
   * revoked since the guard ran, nothing is stored and the answer is the guard's 401. Nothing here
   * logs.
   */
  async ingestBatch(
    userId: string,
    integrationId: string,
    keyId: string,
    body: unknown,
  ): Promise<IngestBatchResponse> {
    assertUserScope(userId);
    const batch = ingestBatchRequestSchema.safeParse(body);
    if (!batch.success) throw batchInvalid(batch.error);

    const caller = await this.repository.loadCaller(userId, integrationId);
    // The integration was revoked after the guard let this request through.
    if (caller === null) throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    const rules = await this.ruleSets.get(userId);
    const policies = await this.retention.daysByTarget(userId);

    const receivedAt = this.clock.now();
    const plan = planBatch(batch.data.events, receivedAt, {
      caller,
      rules,
      retention: { type: policies.type, sourceDays: policies.source.get(integrationId) ?? null },
    });
    const events = plan.flatMap((item) => (item.kind === "store" ? [item.event] : []));
    const stored = await this.repository.storeBatch(
      userId,
      integrationId,
      keyId,
      { events, bucket: hourBucket(receivedAt) },
      (ids) => countResults(plan, toResults(plan, ids)),
    );
    // The key or its integration was revoked after the guard let this request through.
    if (stored === null) throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    await this.repository.touchLastSeen(
      userId,
      integrationId,
      receivedAt,
      LAST_SEEN_UPDATE_INTERVAL_MS,
    );
    return { results: toResults(plan, stored) };
  }

  /**
   * `GET /v1/ingest/config`: what the caller's extension needs to apply the user's rules itself.
   * The rules and their version come from ONE compiled set (`RuleSetProvider`), so they always
   * belong together; only enabled `collect` rules are sent (process rules are server-only). The
   * policy is the integration's own and is part of the ETag. Only a `browser-extension`
   * integration applies rules itself, so the key of any other kind is a 403
   * `ingest.config_unsupported` (nothing is read). A stored rule that no longer fits the schema is a 409 `ingest.rule_error` (the client then collects nothing, invariant 1). The user
   * and integration come from the ingest AuthContext only (invariant 4). Nothing here logs.
   */
  async getConfig(
    userId: string,
    integrationId: string,
  ): Promise<{ config: IngestConfigResponse; etag: string }> {
    assertUserScope(userId);
    const caller = await this.repository.loadCaller(userId, integrationId);
    if (caller === null) throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    if (caller.kind !== "browser-extension") {
      throw new AppException(
        403,
        "ingest.config_unsupported",
        "Only a browser extension integration can read the rules",
      );
    }
    const { compiled } = await this.ruleSets.get(userId);
    if (compiled === null) {
      throw new AppException(409, "ingest.rule_error", "The rules could not be loaded");
    }
    const { limits } = await this.limits.list(userId);
    const [focus, schedules] = await Promise.all([
      this.focus.running(userId),
      this.schedules.listEnabled(userId),
    ]);
    const config: IngestConfigResponse = {
      ruleSetVersion: compiled.version,
      defaultPolicy: caller.defaultPolicy,
      rules: [...compiled.collect],
      limits,
      focus,
      schedules,
    };
    return { config, etag: etagOf(config) };
  }

  /**
   * `POST /v1/ingest/heartbeat`. The body was validated by the contract (strict). Stores it as the
   * integration's `last_heartbeat` and bumps `last_seen_at` (throttled). Scope comes from the
   * ingest AuthContext only (invariant 4). Nothing here logs.
   */
  async recordHeartbeat(
    userId: string,
    integrationId: string,
    heartbeat: HeartbeatRequest,
  ): Promise<void> {
    assertUserScope(userId);
    await this.repository.recordHeartbeat(
      userId,
      integrationId,
      { ...heartbeat },
      this.clock.now(),
      LAST_SEEN_UPDATE_INTERVAL_MS,
    );
  }
}

function rejected(code: IngestErrorCode, id: string | undefined): ItemPlan {
  return id === undefined ? { kind: "rejected", code } : { kind: "rejected", code, id };
}

/**
 * The item's id when it is a valid event id (lowercased), so a rejection can echo it. Like
 * `parseEvent()`, it never throws: an item that cannot be read has no id.
 */
function eventIdOf(item: unknown): string | undefined {
  try {
    if (!isPlainObject(item)) return undefined;
    const id = eventIdSchema.safeParse(item.id);
    return id.success ? id.data : undefined;
  } catch {
    return undefined;
  }
}

/** Issues carry paths and schema-written messages only, never input (invariant 6). */
function batchInvalid(error: z.ZodError): AppException {
  return new AppException(400, INGEST_BATCH_INVALID_CODE, "Invalid ingest batch", undefined, {
    issues: toContractIssues(error.issues),
  });
}
