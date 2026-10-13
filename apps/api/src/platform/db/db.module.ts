import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Pool } from "pg";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import { ReadinessRegistry } from "../health/readiness";
import { createDb } from "./db";
import { checkDb } from "./db.readiness";
import { DB, PG_POOL } from "./db.tokens";

/** Registers the readiness check on startup and closes the pool on shutdown. */
@Injectable()
class DbLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.readiness.register("db", () => checkDb(this.pool));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool => {
        const pool = new Pool({
          connectionString: config.DATABASE_URL,
          // Fail fast when the DB is down so /readyz and requests do not hang.
          connectionTimeoutMillis: 2000,
        });
        // An idle client can error (for example the server restarts); without a listener that
        // would crash the process. The error is dropped on purpose: it may contain connection
        // details, and the readiness check reports the DB state.
        pool.on("error", () => {});
        return pool;
      },
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => createDb(pool) },
    DbLifecycle,
  ],
  exports: [PG_POOL, DB],
})
export class DbModule {}
