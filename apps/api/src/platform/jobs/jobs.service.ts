import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { PgBoss, SendOptions } from "pg-boss";
import { ReadinessRegistry } from "../health/readiness";
import { checkJobs } from "./jobs.readiness";
import { JobRegistry } from "./jobs.registry";
import { JOBS_OPTIONS, PG_BOSS } from "./jobs.tokens";

export interface JobsOptions {
  /** true in the worker process (runs handlers); false in the API process (enqueue only). */
  work: boolean;
}

const STOP_TIMEOUT_MS = 30_000;

/**
 * Owns the pg-boss instance. The API process only enqueues (`work: false`), so HTTP latency never
 * competes with job handlers and the worker can be scaled or restarted on its own. The worker
 * process (`work: true`) additionally subscribes the registered handlers.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private started = false;

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(JOBS_OPTIONS) private readonly options: JobsOptions,
    private readonly registry: JobRegistry,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    // pg-boss emits "error" for background failures. Without a listener Node would throw. The
    // error is dropped on purpose: it can contain connection details; readiness reports state.
    this.boss.on("error", () => {});
    this.readiness.register("queue", () => checkJobs(this.boss, () => this.started));
  }

  /** Runs after every module's onModuleInit, so all registrations exist by now. */
  async onApplicationBootstrap(): Promise<void> {
    await this.boss.start();
    this.started = true;
    for (const { queue, queueOptions, handler } of this.registry.list()) {
      await this.boss.createQueue(queue, queueOptions);
      if (!this.options.work) continue;
      await this.boss.work(queue, async (jobs) => {
        for (const job of jobs) await handler({ id: job.id, data: job.data });
      });
    }
  }

  /** Enqueues a job. Returns its id, or null when pg-boss dropped it (for example a singleton). */
  async enqueue(queue: string, data: object = {}, options?: SendOptions): Promise<string | null> {
    return this.boss.send(queue, data, options);
  }

  async onModuleDestroy(): Promise<void> {
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }
}
