import type {
  ContractIssue,
  DeleteRuleResponse,
  Rule,
  RuleDefinition,
  RuleListResponse,
  RuleResponse,
  TestRuleRequest,
  TestRuleResponse,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/rules. Same-origin with the session cookie. Failures throw a generic
 * error (no body, URL or rule value in the message), and nothing here logs. A rejected rule
 * carries the server's `issues` (a path and a fixed message each, never the rule's values).
 */
export type { Rule, RuleDefinition, RuleListResponse, TestRuleResponse };

export class RuleRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly issues: ContractIssue[],
  ) {
    super(`Request failed (${status}).`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as {
      code?: unknown;
      issues?: unknown;
    } | null;
    throw new RuleRequestError(
      res.status,
      typeof problem?.code === "string" ? problem.code : undefined,
      Array.isArray(problem?.issues) ? (problem.issues as ContractIssue[]) : [],
    );
  }
  return (await res.json()) as T;
}

const rulePath = (id: string) => `/v1/rules/${encodeURIComponent(id)}`;

export const listRules = (): Promise<RuleListResponse> => request("GET", "/v1/rules");

export const createRule = (rule: RuleDefinition): Promise<RuleResponse> =>
  request("POST", "/v1/rules", rule);

export const updateRule = (id: string, rule: RuleDefinition): Promise<RuleResponse> =>
  request("PUT", rulePath(id), rule);

export const deleteRule = (id: string): Promise<DeleteRuleResponse> =>
  request("DELETE", rulePath(id));

export const testRule = (req: TestRuleRequest): Promise<TestRuleResponse> =>
  request("POST", "/v1/rules/test", req);
