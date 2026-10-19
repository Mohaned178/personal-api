import { Injectable } from "@nestjs/common";

/**
 * Cleanup that cannot be a database cascade, for example files on disk. It runs BEFORE the
 * deletion transaction, while the rows that say what exists (such as the export paths) are still
 * there; if it throws, nothing has been deleted and the request can simply be repeated. So a step
 * MUST be idempotent: files that are already gone are fine.
 */
export interface AccountDeletionStep {
  /** For error reports only. Never put user data in it. */
  name: string;
  run(userId: string): Promise<void>;
}

/** Modules register their steps in `onModuleInit`, like job handlers. M6-05 registers export files. */
@Injectable()
export class AccountDeletionSteps {
  private readonly steps: AccountDeletionStep[] = [];

  /** Returns a function that removes the step again (for tests). */
  register(step: AccountDeletionStep): () => void {
    this.steps.push(step);
    return () => {
      const index = this.steps.indexOf(step);
      if (index >= 0) this.steps.splice(index, 1);
    };
  }

  list(): readonly AccountDeletionStep[] {
    return this.steps;
  }
}
