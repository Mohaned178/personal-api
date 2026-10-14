import { eq, getTableColumns, is, type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "./db";

/**
 * The tenant-scoped repository helper (invariant 4): every query on user data goes through it,
 * and it cannot be created, so cannot run a query, without a userId. The userId comes from the
 * AuthContext, never from the request.
 */

/** Thrown (synchronously by `tenantScope`, or as a rejection by repository methods) when no usable userId is given. */
export class MissingUserScopeError extends Error {
  constructor(message = "a userId is required to query tenant data") {
    super(message);
    this.name = "MissingUserScopeError";
  }
}

/** A scoped call that would touch rows outside the scope: a foreign `userId`, or a table without `user_id`. */
export class TenantScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeViolationError";
  }
}

export type TenantTable = PgTable & { userId: AnyPgColumn };
export type TenantInsert<T extends TenantTable> = Omit<T["$inferInsert"], "userId"> & {
  userId?: never;
};
/** Columns to change (never `userId`). A value may be a Drizzle `sql` expression. */
export type TenantUpdate<T extends TenantTable> = {
  [K in keyof Omit<T["$inferInsert"], "userId">]?: T["$inferInsert"][K] | SQL;
};

/** What the helper needs from a database handle (the app's `Database`, or a transaction). */
export type TenantDb = Pick<Database, "select" | "insert" | "update" | "delete">;

export interface TenantScope {
  readonly userId: string;
  /** Every method ANDs `user_id = <scope user>` onto the caller's `where`; it can never widen. */
  select<T extends TenantTable>(table: T, where?: SQL): Promise<Array<T["$inferSelect"]>>;
  /** Stamps the scope's userId on every row. A value carrying any other userId is rejected. */
  insert<T extends TenantTable>(
    table: T,
    values: TenantInsert<T> | TenantInsert<T>[],
  ): Promise<Array<T["$inferSelect"]>>;
  /** Rejects a `set` that contains `userId` (rows never move between tenants). */
  update<T extends TenantTable>(
    table: T,
    set: TenantUpdate<T>,
    where?: SQL,
  ): Promise<Array<T["$inferSelect"]>>;
  delete<T extends TenantTable>(table: T, where?: SQL): Promise<Array<T["$inferSelect"]>>;
}

/** Throws `MissingUserScopeError` unless `userId` is a non-blank string. */
export function assertUserScope(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || userId.trim() === "") throw new MissingUserScopeError();
}

/** The table's `user_id` column. Refuses anything that is not a Drizzle table owned per user. */
function userColumn(table: unknown): PgColumn {
  if (!is(table, PgTable)) {
    throw new TenantScopeViolationError("not a database table");
  }
  const column = (getTableColumns(table) as Record<string, unknown>).userId;
  if (!is(column, PgColumn) || column.name !== "user_id") {
    throw new TenantScopeViolationError("table has no user_id column, so it is not tenant data");
  }
  return column;
}

/**
 * `user_id = $userId AND (<where>)`. The caller's condition is parenthesized explicitly: Drizzle's
 * `and()` does not wrap its operands, so a raw `sql\`a OR b\`` would otherwise escape the scope.
 */
export function scopeCondition(table: TenantTable, userId: string, where?: SQL): SQL {
  assertUserScope(userId);
  const owned = eq(userColumn(table), userId);
  return where === undefined ? owned : sql`${owned} and (${where})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws `MissingUserScopeError` for undefined, null, non-string or blank userId. */
export function tenantScope(db: TenantDb, userId: string): TenantScope {
  assertUserScope(userId);

  // Methods are async so every refusal (bad table, foreign userId) is a rejection, never a query.
  const scope: TenantScope = {
    userId,

    async select<T extends TenantTable>(table: T, where?: SQL) {
      const condition = scopeCondition(table, userId, where);
      const rows = await db
        .select()
        .from(table as PgTable)
        .where(condition);
      return rows as Array<T["$inferSelect"]>;
    },

    async insert<T extends TenantTable>(table: T, values: TenantInsert<T> | TenantInsert<T>[]) {
      userColumn(table);
      const list: unknown[] = Array.isArray(values) ? values : [values];
      const stamped = list.map((value) => {
        if (!isRecord(value)) throw new TypeError("insert values must be objects");
        if (Object.hasOwn(value, "userId") && value.userId !== userId) {
          throw new TenantScopeViolationError("insert value carries another user's id");
        }
        return { ...value, userId };
      });
      if (stamped.length === 0) return [];
      const rows = await db
        .insert(table)
        .values(stamped as never)
        .returning();
      return rows as Array<T["$inferSelect"]>;
    },

    async update<T extends TenantTable>(table: T, set: TenantUpdate<T>, where?: SQL) {
      const condition = scopeCondition(table, userId, where);
      if (!isRecord(set)) throw new TypeError("update set must be an object");
      if (Object.hasOwn(set, "userId")) {
        throw new TenantScopeViolationError("update cannot change a row's user");
      }
      const rows = await db
        .update(table)
        .set(set as never)
        .where(condition)
        .returning();
      return rows as Array<T["$inferSelect"]>;
    },

    async delete<T extends TenantTable>(table: T, where?: SQL) {
      const condition = scopeCondition(table, userId, where);
      const rows = await db.delete(table).where(condition).returning();
      return rows as Array<T["$inferSelect"]>;
    },
  };
  return Object.freeze(scope);
}
