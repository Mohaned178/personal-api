import type { SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "./db";

/**
 * M1-03 (test-writer stub). The tenant-scoped repository helper (invariant 4): every query on
 * user data goes through it, and it cannot be created, so cannot run a query, without a userId.
 */

/** Thrown (synchronously by `tenantScope`, or as a rejection by repository methods) when no usable userId is given. */
export class MissingUserScopeError extends Error {
  constructor(message = "a userId is required to query tenant data") {
    super(message);
    this.name = "MissingUserScopeError";
  }
}

export type TenantTable = PgTable & { userId: AnyPgColumn };
export type TenantInsert<T extends TenantTable> = Omit<T["$inferInsert"], "userId"> & {
  userId?: never;
};

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
    set: Partial<Omit<T["$inferInsert"], "userId">>,
    where?: SQL,
  ): Promise<Array<T["$inferSelect"]>>;
  delete<T extends TenantTable>(table: T, where?: SQL): Promise<Array<T["$inferSelect"]>>;
}

/** Throws `MissingUserScopeError` for undefined, null, non-string or blank userId. */
export function tenantScope(_db: Database, _userId: string): TenantScope {
  throw new Error("not implemented: tenantScope");
}
