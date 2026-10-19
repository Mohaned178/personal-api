import { Inject, Injectable } from "@nestjs/common";
import { timeZoneSchema } from "@personal-api/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";

/**
 * The time zone names the database accepts. Days are cut by Postgres (`AT TIME ZONE`), and its
 * list is not Node's: the system tzdata of the Postgres image lacks legacy link names such as
 * `Asia/Calcutta`, which Node (ICU) accepts. This is not user data, so there is no `userId`.
 * Names are bound parameters (invariant 7).
 */
@Injectable()
export class TimeZoneCatalog {
  constructor(@Inject(DB) private readonly db: Database) {}

  async has(name: string): Promise<boolean> {
    const { rows } = await this.db.execute(
      sql`select 1 from pg_timezone_names where name = ${name} limit 1`,
    );
    return rows.length > 0;
  }

  /**
   * Sorted, and only names the settings schema takes, so every entry can be sent back with PATCH
   * (this leaves out the `posix/` and `right/` copies and `Factory`, which Node does not know).
   */
  async list(): Promise<string[]> {
    const { rows } = await this.db.execute<{ name: string }>(
      sql`select name from pg_timezone_names`,
    );
    return rows
      .map((row) => row.name)
      .filter((name) => timeZoneSchema.safeParse(name).success)
      .sort();
  }
}
