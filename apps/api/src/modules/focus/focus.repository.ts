import { Inject, Injectable } from "@nestjs/common";
import { type FocusSession, focusSessionSchema } from "@personal-api/contracts";
import { eq, gt } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { focusSessions, user } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type FocusRow = typeof focusSessions.$inferSelect;

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class FocusRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's session if it has not ended at `now`, else null. */
  async current(userId: string, now: Date): Promise<FocusSession | null> {
    const [row] = await tenantScope(this.db, userId).select(
      focusSessions,
      gt(focusSessions.endsAt, now),
    );
    return row ? toSession(row) : null;
  }

  /** Replaces the user's session. The user's row is locked first, so two starts cannot collide. */
  async start(userId: string, patterns: string[], endsAt: Date, at: Date): Promise<FocusSession> {
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
      const scope = tenantScope(tx, userId);
      await scope.delete(focusSessions);
      const [row] = await scope.insert(focusSessions, { patterns, endsAt, createdAt: at });
      if (!row) throw new Error("focus insert returned no row");
      return toSession(row);
    });
  }

  /** True when the user had a session (running or not) to remove. */
  async end(userId: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(focusSessions);
    return rows.length > 0;
  }
}

/** Parsed again on the way out: a stored row that no longer fits the schema is a 500. */
function toSession(row: FocusRow): FocusSession {
  return focusSessionSchema.parse({
    id: row.id,
    patterns: row.patterns,
    endsAt: row.endsAt.toISOString(),
  });
}
