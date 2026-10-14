/**
 * M1-01 test-first STUB. The builder replaces this file (and the whole package scaffold) with the
 * real Zod-based implementation. It only exists so the specs compile and fail with
 * "not implemented" instead of an import error. The names and shapes below are the public
 * interface the specs pin; see the test-writer report for the full list.
 */

export type IngestErrorCode =
  | "ingest.envelope_invalid"
  | "ingest.type_unknown"
  | "ingest.type_version_unknown"
  | "ingest.payload_invalid";

export interface ContractIssue {
  path: (string | number)[];
  message: string;
}

export interface EventEnvelope {
  id: string;
  type: string;
  typeVersion: number;
  occurredAt: string;
  data: Record<string, unknown>;
  meta?: { ruleSetVersion: number; client: string };
}

export type ParseEventResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; code: IngestErrorCode; issues: ContractIssue[] };

/** Minimal schema surface the specs use (the real exports are Zod schemas). */
export interface SafeParseSchema {
  safeParse(input: unknown): { success: boolean };
}

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name}`);
}

export function parseEvent(_input: unknown): ParseEventResult {
  return notImplemented("parseEvent");
}

export const ingestBatchRequestSchema: SafeParseSchema = {
  safeParse: () => notImplemented("ingestBatchRequestSchema"),
};

export const ingestItemResultSchema: SafeParseSchema = {
  safeParse: () => notImplemented("ingestItemResultSchema"),
};
