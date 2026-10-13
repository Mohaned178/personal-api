import { Injectable } from "@nestjs/common";
import type { Queue } from "pg-boss";

/** What a handler sees. Never log `data`: it can carry user data. */
export interface JobContext {
  id: string;
  data: unknown;
}

export interface JobRegistration {
  /** Queue name, for example `retention.purge`. Created explicitly on startup. */
  queue: string;
  /**
   * MUST be idempotent. pg-boss delivers at least once: a job can run again after a crash,
   * a timeout or a retry, so running it twice must leave the same result as running it once.
   * Throw to fail the job (it is retried per the queue's options).
   */
  handler: (job: JobContext) => Promise<void>;
  /** Passed to `createQueue` (retry limit, dead-letter queue, ...). */
  queueOptions?: Omit<Queue, "name">;
}

/**
 * Domain modules inject this and call `register` in `onModuleInit`. Registrations are read by
 * JobsService at application bootstrap, which runs after every module's `onModuleInit`.
 */
@Injectable()
export class JobRegistry {
  private readonly registrations = new Map<string, JobRegistration>();

  register(registration: JobRegistration): void {
    if (this.registrations.has(registration.queue)) {
      throw new Error(`job queue already registered: ${registration.queue}`);
    }
    this.registrations.set(registration.queue, registration);
  }

  list(): JobRegistration[] {
    return [...this.registrations.values()];
  }
}
