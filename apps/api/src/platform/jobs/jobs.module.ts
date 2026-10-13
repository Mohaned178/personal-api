import { type DynamicModule, Global, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { PgBoss } from "pg-boss";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import { JobRegistry } from "./jobs.registry";
import { type JobsOptions, JobsService } from "./jobs.service";
import { JOBS_OPTIONS, NOOP_QUEUE, PG_BOSS } from "./jobs.tokens";

/** Registers the built-in no-op queue. Trivially idempotent. */
@Injectable()
class NoopJob implements OnModuleInit {
  constructor(private readonly registry: JobRegistry) {}

  onModuleInit(): void {
    this.registry.register({ queue: NOOP_QUEUE, handler: async () => {} });
  }
}

@Global()
@Module({})
// Static factory is the standard Nest dynamic-module shape.
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic module
export class JobsModule {
  static forRoot(options: JobsOptions): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        { provide: JOBS_OPTIONS, useValue: options },
        {
          provide: PG_BOSS,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): PgBoss =>
            new PgBoss({ connectionString: config.DATABASE_URL }),
        },
        JobRegistry,
        NoopJob,
        JobsService,
      ],
      exports: [JobRegistry, JobsService, PG_BOSS],
    };
  }
}
