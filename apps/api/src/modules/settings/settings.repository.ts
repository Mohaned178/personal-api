import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { user } from "../../platform/db/schema";
import { assertUserScope } from "../../platform/db/tenant-scope";

/**
 * Settings live on the user's own row, which has no `user_id` column, so this does not go through
 * `tenantScope`: every method takes `userId` FIRST, rejects a missing one before touching the
 * database, and filters on `user.id = userId`. Keep helpers out of the class (or prefix them with
 * `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class SettingsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getTimeZone(userId: string): Promise<string | null> {
    assertUserScope(userId);
    const [row] = await this.db
      .select({ timeZone: user.timeZone })
      .from(user)
      .where(eq(user.id, userId));
    return row?.timeZone ?? null;
  }

  async setTimeZone(userId: string, timeZone: string): Promise<string | null> {
    assertUserScope(userId);
    const [row] = await this.db
      .update(user)
      .set({ timeZone })
      .where(eq(user.id, userId))
      .returning({ timeZone: user.timeZone });
    return row?.timeZone ?? null;
  }
}
