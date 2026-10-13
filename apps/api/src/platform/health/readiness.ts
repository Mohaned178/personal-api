import { Injectable } from "@nestjs/common";

export type ReadinessCheck = () => void | Promise<void>;

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, "up" | "down">;
}

/** Later modules (db, jobs) inject this and call `register` in onModuleInit. */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  /** A check that throws or rejects counts as down. Error details are never exposed. */
  async run(): Promise<ReadinessResult> {
    const entries = await Promise.all(
      [...this.checks].map(async ([name, check]): Promise<[string, "up" | "down"]> => {
        try {
          await check();
          return [name, "up"];
        } catch {
          return [name, "down"];
        }
      }),
    );
    return {
      ready: entries.every(([, state]) => state === "up"),
      checks: Object.fromEntries(entries),
    };
  }
}
