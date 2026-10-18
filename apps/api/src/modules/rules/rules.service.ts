import { Inject, Injectable } from "@nestjs/common";
import {
  type DeleteRuleResponse,
  RULE_LIMIT_REACHED_CODE,
  RULE_NOT_FOUND_CODE,
  RULES_PER_USER_MAX,
  type Rule,
  type RuleDefinition,
  type RuleListResponse,
  type RuleResponse,
  type TestRuleRequest,
  type TestRuleResponse,
} from "@personal-api/contracts";
import { compileRuleSet, evaluate } from "@personal-api/rules";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import { type RuleChangeResult, RulesRepository } from "./rules.repository";

/** Id of an unsaved draft in a dry run. It only shows up in the response's trace. */
const DRAFT_RULE_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Rules for one user. `userId` always comes from the session AuthContext. An unknown id, someone
 * else's id and a malformed id all give the same 404, so the API never confirms that another
 * user's rule exists. Definitions are validated by the request DTO (the contracts' schema) before
 * they get here.
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly repository: RulesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<RuleListResponse> {
    assertUserScope(userId);
    return this.repository.list(userId);
  }

  async get(userId: string, id: string): Promise<RuleResponse> {
    assertUserScope(userId);
    const found = isUuid(id) ? await this.repository.findById(userId, id) : null;
    if (!found) throw notFound();
    return found;
  }

  async create(userId: string, definition: RuleDefinition): Promise<RuleResponse> {
    assertUserScope(userId);
    return changed(await this.repository.create(userId, definition, this.clock.now()));
  }

  async replace(userId: string, id: string, definition: RuleDefinition): Promise<RuleResponse> {
    assertUserScope(userId);
    if (!isUuid(id)) throw notFound();
    return changed(await this.repository.replace(userId, id, definition, this.clock.now()));
  }

  async remove(userId: string, id: string): Promise<DeleteRuleResponse> {
    assertUserScope(userId);
    if (!isUuid(id)) throw notFound();
    const { version } = changed(await this.repository.remove(userId, id, this.clock.now()));
    return { version };
  }

  /**
   * Dry run: the same engine the extension and the ingest path use, against a sample event.
   * Nothing is stored, counted or logged. A rule set that does not compile answers `error`
   * (fail closed), never a guess.
   */
  async test(userId: string, request: TestRuleRequest): Promise<TestRuleResponse> {
    assertUserScope(userId);
    const saved = await this.repository.list(userId);
    const replaced = request.replaceRuleId;
    if (replaced !== undefined && !saved.rules.some((rule) => rule.id === replaced)) {
      throw notFound();
    }

    const compiled = compileRuleSet({
      version: saved.version,
      rules: withDraft(saved.rules, request),
    });
    if (!compiled.ok) return { decision: "error", reason: "failed" };

    const result = evaluate(request.event, compiled.ruleSet, request.defaultPolicy, {
      source: request.source,
    });
    if (result.decision !== "allow") return result;
    return {
      decision: "allow",
      event: result.event,
      tags: result.tags,
      retentionDays: result.retentionDays,
      keepQuery: result.keepQuery,
      trace: result.trace,
    };
  }
}

/** The saved rules, with the draft added, swapped in for one of them, or alone. */
function withDraft(saved: readonly Rule[], request: TestRuleRequest): Rule[] {
  if (request.rule === undefined) return [...saved];
  const draft: Rule = { id: request.replaceRuleId ?? DRAFT_RULE_ID, ...request.rule };
  if (request.onlyRule === true) return [draft];
  return [...saved.filter((rule) => rule.id !== draft.id), draft];
}

function notFound(): AppException {
  return new AppException(404, RULE_NOT_FOUND_CODE, "Rule not found");
}

function changed(result: RuleChangeResult): { rule: Rule; version: number } {
  if (result === "not_found") throw notFound();
  if (result === "limit_reached") {
    throw new AppException(
      409,
      RULE_LIMIT_REACHED_CODE,
      "Rule limit reached",
      `A user can have at most ${RULES_PER_USER_MAX} rules`,
    );
  }
  return result;
}
