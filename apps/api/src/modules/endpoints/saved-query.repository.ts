import { Inject, Injectable } from "@nestjs/common";
import {
  SAVED_QUERY_FIELDS,
  SAVED_QUERY_LIMITS,
  SAVED_QUERY_TIMEOUT_MS,
  type SavedQueryField,
  type SavedQueryResult,
  savedQueryFieldKey,
} from "@personal-api/contracts";
import { and, asc, desc, type SQL, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events } from "../../platform/db/schema";
import { assertUserScope, scopeCondition } from "../../platform/db/tenant-scope";
import { activeMs } from "../activity/activity.repository";
import type { CompiledSavedQuery } from "./saved-query.compiler";

type Cell = string | number | null;

export interface SavedQueryRunOptions {
  /** Defaults to the 2 seconds of PLAN §6. Tests pass a smaller one. */
  timeoutMs?: number;
}

/**
 * Runs a compiled saved query for one user. `userId` is the FIRST argument and is ANDed on through
 * `scopeCondition` (invariant 4). Every run is one read-only transaction with its own
 * `statement_timeout` (`set_config(..., true)` is local to the transaction, so it can never leak to
 * the next query on the pool), and every query has a LIMIT of at most 1,000 rows, aggregates
 * included. It asks for one row more than the limit to tell the caller whether it cut.
 *
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class SavedQueryRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async run(
    userId: string,
    query: CompiledSavedQuery,
    options: SavedQueryRunOptions = {},
  ): Promise<SavedQueryResult> {
    assertUserScope(userId);
    const where = scopeCondition(events, userId, query.where);
    const limit = rowLimit(query.limit);
    const timeoutMs = options.timeoutMs ?? SAVED_QUERY_TIMEOUT_MS;

    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
        const cut = <T>(rows: T[]) => ({
          rows: rows.slice(0, limit),
          truncated: rows.length > limit,
        });

        switch (query.kind) {
          case "events": {
            const fields = projection(query.fields);
            const rows = await tx
              .select(Object.fromEntries(fields.map((f) => [f.key, f.expression])))
              .from(events)
              .where(where)
              .orderBy(desc(events.occurredAt), desc(events.id))
              .limit(limit + 1);
            return {
              kind: "events",
              ...cut(
                rows.map((row) =>
                  Object.fromEntries(fields.map((f) => [f.key, f.cell(row[f.key])])),
                ),
              ),
            };
          }
          case "count_by_day": {
            const date = sql<string>`to_char(${events.occurredAt} at time zone ${query.timeZone}::text, 'YYYY-MM-DD')`;
            const rows = await tx
              .select({ date, count: sql<string>`count(*)` })
              .from(events)
              .where(where)
              // Positional: the bound time zone is a separate parameter wherever `date` is repeated.
              .groupBy(sql`1`)
              .orderBy(sql`1`)
              .limit(limit + 1);
            return {
              kind: "count_by_day",
              ...cut(rows.map((r) => ({ date: r.date, count: Number(r.count) }))),
            };
          }
          case "count_by_domain": {
            const domain = domainField();
            const count = sql<string>`count(*)`;
            const rows = await tx
              .select({ domain, count })
              .from(events)
              .where(scopeCondition(events, userId, and(query.where, sql`${domain} is not null`)))
              .groupBy(domain)
              .orderBy(desc(count), asc(domain))
              .limit(limit + 1);
            return {
              kind: "count_by_domain",
              ...cut(rows.map((r) => ({ domain: r.domain, count: Number(r.count) }))),
            };
          }
          case "duration_by_domain": {
            const domain = domainField();
            const rows = await tx
              .select({ domain, activeMs })
              .from(events)
              .where(scopeCondition(events, userId, and(query.where, sql`${domain} is not null`)))
              .groupBy(domain)
              .orderBy(desc(activeMs), asc(domain))
              .limit(limit + 1);
            return {
              kind: "duration_by_domain",
              ...cut(rows.map((r) => ({ domain: r.domain, activeMs: Number(r.activeMs) }))),
            };
          }
          default:
            return assertNever(query);
        }
      },
      { accessMode: "read only" },
    );
  }
}

/** The domain of an event, or NULL when it has none (or not as text). */
function domainField(): SQL<string> {
  return sql<string>`(case when jsonb_typeof(${events.data} -> 'domain') = 'string' then ${events.data} ->> 'domain' end)`;
}

/** At most 1,000 rows and at least 1, whatever a hand-built query says. */
function rowLimit(requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) return SAVED_QUERY_LIMITS.rowsDefault;
  return Math.min(requested, SAVED_QUERY_LIMITS.rowsMax);
}

interface ProjectedField {
  key: string;
  expression: SQL;
  cell: (value: unknown) => Cell;
}

const isField = (value: string): value is SavedQueryField =>
  (SAVED_QUERY_FIELDS as readonly string[]).includes(value);

/**
 * The columns of a projection. A field is looked up in the closed list, the output key comes from
 * the contract's map and never from the caller's text, and a JSON key is a bound parameter.
 */
function projection(fields: readonly string[]): ProjectedField[] {
  return fields.map((field) => {
    if (!isField(field)) throw new Error("unknown saved query field");
    const key = savedQueryFieldKey(field);
    if (field === "type") return { key, expression: sql`${events.type}`, cell: toCell };
    if (field === "occurredAt") {
      // The driver hands timestamps over as text; UTC with milliseconds is the API's format.
      return {
        key,
        expression: sql`to_char(${events.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        cell: toCell,
      };
    }
    return {
      key,
      expression: sql`(${events.data} -> ${field.slice("data.".length)}::text)`,
      cell: toCell,
    };
  });
}

/** Only strings and numbers leave the API; anything else (a missing field, an odd value) is null. */
function toCell(value: unknown): Cell {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function assertNever(value: never): never {
  void value;
  throw new Error("unknown saved query kind");
}
