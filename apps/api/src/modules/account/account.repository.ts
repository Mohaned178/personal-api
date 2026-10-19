import { Inject, Injectable } from "@nestjs/common";
import { eq, or, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { account, user, verification } from "../../platform/db/schema";
import { assertUserScope, tenantScope } from "../../platform/db/tenant-scope";

/** `userId` is always the FIRST argument and always comes from the session's AuthContext. */
@Injectable()
export class AccountRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The hash of the user's email + password login, or null when the account has none. */
  async findPasswordHash(userId: string): Promise<string | null> {
    const rows = await tenantScope(this.db, userId).select(
      account,
      eq(account.providerId, "credential"),
    );
    return rows[0]?.password ?? null;
  }

  /**
   * Removes the account in ONE transaction, so there is never a half-deleted account:
   *  1. queued and finished pg-boss jobs whose payload names the user (job payloads carry a user
   *     id, and the table has no foreign key to cascade from),
   *  2. Better Auth's `verification` rows, which are keyed by identifier or value instead of a
   *     user id, so the cascade misses them,
   *  3. the `user` row. Every other table has `user_id ... ON DELETE CASCADE` (sessions, accounts,
   *     integrations, keys, events, rules, endpoints, ...); account.int.spec.ts proves that for
   *     every table in the schema.
   * The values are bound parameters (invariant 7). Nothing is read back.
   */
  async deleteAccount(userId: string, email: string): Promise<void> {
    assertUserScope(userId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`delete from pgboss.job where data ->> 'userId' = ${userId}`);
      await tx
        .delete(verification)
        .where(or(eq(verification.identifier, email), eq(verification.value, userId)));
      await tx.delete(user).where(eq(user.id, userId));
    });
  }
}
