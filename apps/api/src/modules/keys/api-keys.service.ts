import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import type { IngestAuthContext } from "../auth/auth-context";
import { ApiKeysRepository } from "./api-keys.repository";

/** last_used_at is written at most once per this interval per key (builder may tune the value). */
export const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export interface CreatedApiKey {
  id: string;
  /** The plaintext key. Returned here once and never stored. */
  key: string;
  prefix: string;
}

/** M1-03 (test-writer stub). */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly repository: ApiKeysRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates an ingest key for an integration the user owns. Rejects (and stores nothing) when the
   * integration does not exist or belongs to another user.
   */
  async createIngestKey(_userId: string, _integrationId: string): Promise<CreatedApiKey> {
    void this.repository;
    void this.clock;
    throw new Error("not implemented: ApiKeysService.createIngestKey");
  }

  /** Sets revoked_at (clock time). Returns false when the key is not the user's, or unknown. */
  async revokeKey(_userId: string, _keyId: string): Promise<boolean> {
    throw new Error("not implemented: ApiKeysService.revokeKey");
  }

  /**
   * Resolves a presented bearer token to an ingest AuthContext, or null for anything else:
   * unknown, malformed, revoked, revoked integration, or a pa_read_ key. Never throws for bad
   * input. Bumps last_used_at (throttled) on success only.
   */
  async authenticateIngestKey(_presented: string | undefined): Promise<IngestAuthContext | null> {
    throw new Error("not implemented: ApiKeysService.authenticateIngestKey");
  }
}
