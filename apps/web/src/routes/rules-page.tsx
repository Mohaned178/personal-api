import type {
  ContractIssue,
  Rule,
  RuleDefinition,
  TestRuleResponse,
} from "@personal-api/contracts";
import { INTEGRATION_KINDS, RULE_ACTIONS_BY_STAGE } from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDiagnostics } from "@/lib/diagnostics";
import {
  type ActionDraft,
  type ActionName,
  actionNeedsParam,
  CONDITION_FIELDS,
  CONDITION_GROUPS,
  type ConditionDraft,
  type ConditionGroup,
  draftToRule,
  emptyDraft,
  formatIssuePath,
  newCondition,
  opsForField,
  REDACTABLE_FIELDS,
  type RuleDraft,
  ruleToDraft,
  validateRule,
} from "@/lib/rule-draft";
import { RULE_TEMPLATES, type RuleTemplate } from "@/lib/rule-templates";
import {
  createRule,
  deleteRule,
  listRules,
  RuleRequestError,
  testRule,
  updateRule,
} from "@/lib/rules";

const RULES_KEY = ["rules"] as const;
/** Drops are counted over the longest window the diagnostics route offers. */
const DROP_WINDOW_HOURS = 168;
const DIAGNOSTICS_KEY = ["diagnostics", "rule-drops"] as const;

const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function summarize(rule: Rule): string {
  return rule.then.map((a) => a.action).join(", ");
}

function Issues({ issues }: { issues: ContractIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert" aria-label="Problems with this rule" className="text-sm text-destructive">
      {issues.map((issue) => (
        <li key={`${issue.path.join(".")}:${issue.message}`}>
          <code>{formatIssuePath(issue.path)}</code>: {issue.message}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child passed in
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ConditionRow({
  group,
  index,
  condition,
  onChange,
  onRemove,
}: {
  group: ConditionGroup;
  index: number;
  condition: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  onRemove: () => void;
}) {
  const where = `${group} condition ${index + 1}`;
  const ops = opsForField(condition.field);
  return (
    <li className="flex flex-wrap items-end gap-2">
      <select
        aria-label={`${where} field`}
        className={selectClass}
        value={condition.field}
        onChange={(e) => {
          const field = e.target.value;
          const allowed = opsForField(field);
          onChange({
            ...condition,
            field,
            op: allowed.includes(condition.op) ? condition.op : (allowed[0] ?? condition.op),
          });
        }}
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f.field} value={f.field}>
            {f.field}
          </option>
        ))}
      </select>
      <select
        aria-label={`${where} operator`}
        className={selectClass}
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionDraft["op"] })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      {condition.op === "exists" ? (
        <select
          aria-label={`${where} value`}
          className={selectClass}
          value={condition.value === "false" ? "false" : "true"}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <Input
          aria-label={`${where} value`}
          className="w-56"
          value={condition.value}
          placeholder={condition.op === "in" ? "a, b, c" : "value"}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
}

function ActionRow({
  stage,
  index,
  action,
  onChange,
  onRemove,
}: {
  stage: RuleDraft["stage"];
  index: number;
  action: ActionDraft;
  onChange: (next: ActionDraft) => void;
  onRemove: () => void;
}) {
  const where = `action ${index + 1}`;
  return (
    <li className="flex flex-wrap items-end gap-2">
      <select
        aria-label={`${where} type`}
        className={selectClass}
        value={action.action}
        onChange={(e) => onChange({ action: e.target.value as ActionName, param: "" })}
      >
        {RULE_ACTIONS_BY_STAGE[stage].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {action.action === "redact" ? (
        <select
          aria-label={`${where} field`}
          className={selectClass}
          value={action.param}
          onChange={(e) => onChange({ ...action, param: e.target.value })}
        >
          <option value="">Choose a field</option>
          {REDACTABLE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      ) : (
        actionNeedsParam(action.action) && (
          <Input
            aria-label={`${where} value`}
            className="w-40"
            value={action.param}
            placeholder={
              action.action === "coarsen"
                ? "segments (0-10)"
                : action.action === "tag"
                  ? "tag"
                  : "days"
            }
            onChange={(e) => onChange({ ...action, param: e.target.value })}
          />
        )
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
}

function RuleForm({ draft, onChange }: { draft: RuleDraft; onChange: (next: RuleDraft) => void }) {
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const setGroup = (group: ConditionGroup, list: ConditionDraft[]) =>
    onChange({ ...draft, conditions: { ...draft.conditions, [group]: list } });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
        </div>
        <Field label="Priority (lower runs first)">
          <Input
            inputMode="numeric"
            value={draft.priority}
            onChange={(e) => set("priority", e.target.value)}
          />
        </Field>
        <Field label="Stage">
          <select
            className={selectClass}
            value={draft.stage}
            onChange={(e) => {
              const stage = e.target.value as RuleDraft["stage"];
              onChange({
                ...draft,
                stage,
                then: [{ action: RULE_ACTIONS_BY_STAGE[stage][0], param: "" }],
              });
            }}
          >
            <option value="collect">collect</option>
            <option value="process">process</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        Enabled
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">When</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {INTEGRATION_KINDS.map((source) => (
            <label key={source} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.sources.includes(source)}
                onChange={(e) =>
                  set(
                    "sources",
                    e.target.checked
                      ? [...draft.sources, source]
                      : draft.sources.filter((s) => s !== source),
                  )
                }
              />
              Source: {source}
            </label>
          ))}
        </div>
        <Field label="Event types (comma-separated, * allowed; empty means every type)">
          <Input
            value={draft.types}
            placeholder="browser.*"
            onChange={(e) => set("types", e.target.value)}
          />
        </Field>
        {CONDITION_GROUPS.map((group) => (
          <div key={group} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {group === "all"
                  ? "All of these hold"
                  : group === "any"
                    ? "At least one holds"
                    : "None of these hold"}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setGroup(group, [...draft.conditions[group], newCondition()])}
              >
                Add “{group}” condition
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {draft.conditions[group].map((c, i) => (
                <ConditionRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                  key={i}
                  group={group}
                  index={i}
                  condition={c}
                  onChange={(next) =>
                    setGroup(
                      group,
                      draft.conditions[group].map((x, j) => (j === i ? next : x)),
                    )
                  }
                  onRemove={() =>
                    setGroup(
                      group,
                      draft.conditions[group].filter((_, j) => j !== i),
                    )
                  }
                />
              ))}
            </ul>
          </div>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Then</legend>
        <ul className="flex flex-col gap-2">
          {draft.then.map((a, i) => (
            <ActionRow
              stage={draft.stage}
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              key={i}
              index={i}
              action={a}
              onChange={(next) =>
                set(
                  "then",
                  draft.then.map((x, j) => (j === i ? next : x)),
                )
              }
              onRemove={() =>
                set(
                  "then",
                  draft.then.filter((_, j) => j !== i),
                )
              }
            />
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              set("then", [
                ...draft.then,
                { action: RULE_ACTIONS_BY_STAGE[draft.stage][0], param: "" },
              ])
            }
          >
            Add action
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

function sampleEvent(): string {
  return JSON.stringify(
    {
      id: crypto.randomUUID(),
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { domain: "github.com", path: "/settings/profile", tabRef: "sample-tab-1" },
    },
    null,
    2,
  );
}

function describeResult(result: TestRuleResponse): string {
  if (result.decision === "error") return `Error: the engine could not decide (${result.reason}).`;
  const by =
    result.trace.decidedBy === "default_policy"
      ? "the default policy"
      : result.trace.decidedBy === "client"
        ? "the extension"
        : `rule ${result.trace.decidedBy}`;
  return result.decision === "allow"
    ? `Collected, decided by ${by}.`
    : `Dropped, decided by ${by}.`;
}

function TestPanel({
  getRule,
  replaceRuleId,
}: {
  getRule: () => RuleDefinition | null;
  replaceRuleId: string | undefined;
}) {
  const [eventText, setEventText] = useState(sampleEvent);
  const [source, setSource] = useState<(typeof INTEGRATION_KINDS)[number]>("browser-extension");
  const [only, setOnly] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<TestRuleResponse | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      setProblem(null);
      setResult(null);
      let event: unknown;
      try {
        event = JSON.parse(eventText);
      } catch {
        setProblem("The sample event is not valid JSON.");
        return;
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        setProblem("The sample event must be a JSON object.");
        return;
      }
      const rule = getRule();
      if (!rule) {
        setProblem("Fix the problems in the rule above before testing it.");
        return;
      }
      setResult(
        await testRule({
          event: event as Record<string, unknown>,
          source,
          defaultPolicy: "deny",
          rule,
          ...(replaceRuleId ? { replaceRuleId } : {}),
          ...(only ? { onlyRule: true } : {}),
        }),
      );
    },
    onError: () => setProblem("The test could not run. Check the rule and the sample event."),
  });

  return (
    <section aria-label="Test against a sample event" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Test against a sample event</h3>
      <textarea
        aria-label="Sample event"
        className="h-40 w-full rounded-md border bg-background p-2 font-mono text-xs"
        value={eventText}
        onChange={(e) => setEventText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select
          aria-label="Sample source"
          className={selectClass}
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
        >
          {INTEGRATION_KINDS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />
          Evaluate this rule alone
        </label>
        <Button
          type="button"
          variant="outline"
          onClick={() => run.mutate()}
          disabled={run.isPending}
        >
          Test rule
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm">
          {describeResult(result)}
        </p>
      )}
    </section>
  );
}

function RuleEditor({
  rule,
  template,
  onClose,
}: {
  rule: Rule | undefined;
  /** Fills a new rule's form; ignored when editing. Nothing is saved until the user saves. */
  template?: RuleDefinition | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState<RuleDraft>(() => {
    if (!rule) return template ? ruleToDraft(template) : emptyDraft();
    const { id: _id, ...definition } = rule;
    return ruleToDraft(definition);
  });
  const [jsonText, setJsonText] = useState("");
  const [issues, setIssues] = useState<ContractIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** The rule document in the current mode, or null with the problems shown. */
  function currentRule(): RuleDefinition | null {
    let document: unknown;
    if (mode === "form") document = draftToRule(draft);
    else {
      try {
        document = JSON.parse(jsonText);
      } catch {
        setIssues([{ path: [], message: "Not valid JSON" }]);
        return null;
      }
    }
    const result = validateRule(document);
    setIssues(result.ok ? [] : result.issues);
    return result.ok ? result.rule : null;
  }

  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(JSON.stringify(draftToRule(draft), null, 2));
      setIssues([]);
      setMode("json");
      return;
    }
    const valid = currentRule();
    if (!valid) return;
    setDraft(ruleToDraft(valid));
    setMode("form");
  }

  const save = useMutation({
    mutationFn: async () => {
      setSaveError(null);
      const valid = currentRule();
      if (!valid) return false;
      if (rule) await updateRule(rule.id, valid);
      else await createRule(valid);
      return true;
    },
    onSuccess: async (saved) => {
      if (!saved) return;
      await queryClient.invalidateQueries({ queryKey: RULES_KEY });
      onClose();
    },
    onError: (error) => {
      if (error instanceof RuleRequestError && error.issues.length > 0) setIssues(error.issues);
      else if (error instanceof RuleRequestError && error.code === "rule.limit_reached")
        setSaveError("You have reached the limit of 100 rules.");
      else setSaveError("Could not save the rule. Try again.");
    },
  });

  return (
    <section
      aria-label={rule ? "Edit rule" : "New rule"}
      className="flex flex-col gap-4 rounded-md border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{rule ? "Edit rule" : "New rule"}</h2>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Editor mode</legend>
          <Button
            type="button"
            size="sm"
            variant={mode === "form" ? "default" : "outline"}
            aria-pressed={mode === "form"}
            onClick={() => switchMode("form")}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "json" ? "default" : "outline"}
            aria-pressed={mode === "json"}
            onClick={() => switchMode("json")}
          >
            JSON
          </Button>
        </fieldset>
      </div>

      {mode === "form" ? (
        <RuleForm draft={draft} onChange={setDraft} />
      ) : (
        <textarea
          aria-label="Rule JSON"
          spellCheck={false}
          className="h-72 w-full rounded-md border bg-background p-2 font-mono text-xs"
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            setIssues([]);
          }}
        />
      )}

      <Issues issues={issues} />
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

      <TestPanel getRule={currentRule} replaceRuleId={rule?.id} />

      <div className="flex gap-2">
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          Save rule
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

export function RulesPage() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: listRules });
  const diagnostics = useQuery({
    queryKey: DIAGNOSTICS_KEY,
    queryFn: () => getDiagnostics(DROP_WINDOW_HOURS),
  });
  // `null` is closed, `"new"` is a blank form, a rule is an edit.
  const [editing, setEditing] = useState<Rule | RuleTemplate | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: ({ id, ...definition }: Rule) =>
      updateRule(id, { ...definition, enabled: !definition.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RULES_KEY }),
    onError: () => setActionError("Could not change the rule. Try again."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => {
      setConfirmDelete(null);
      return queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: () => setActionError("Could not delete the rule. Try again."),
  });

  const data = rules.data;
  const drops = diagnostics.data?.drops;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Home
        </Link>
      </header>
      <p className="text-sm text-muted-foreground">
        Nothing is collected unless a rule allows it. Rules run in priority order, lowest number
        first; the first deciding action wins, and a drop beats an allow at the same priority.
      </p>

      {rules.isPending && <p role="status">Loading…</p>}
      {rules.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load rules. Reload the page to try again.
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {editing === null && data && (
        <div>
          <Button onClick={() => setEditing("new")}>New rule</Button>
        </div>
      )}
      {editing !== null && (
        <RuleEditor
          // A new key per target, so switching rules never carries over the old form.
          key={
            editing === "new" ? "new" : "rule" in editing ? `template-${editing.id}` : editing.id
          }
          rule={editing === "new" || "rule" in editing ? undefined : editing}
          template={editing !== "new" && "rule" in editing ? editing.rule : undefined}
          onClose={() => setEditing(null)}
        />
      )}

      {data &&
        (data.rules.length === 0 ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              No rules yet, so nothing is collected. Add a rule to start.
            </p>
            {editing === null && (
              <section aria-label="Start from a template" className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Start from a template</h2>
                <p className="text-sm text-muted-foreground">
                  A template fills in the form. Change the site, then save: nothing is saved until
                  you do.
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {RULE_TEMPLATES.map((template) => (
                    <li key={template.id} className="flex flex-col gap-1 rounded-md border p-3">
                      <Button
                        variant="outline"
                        className="self-start"
                        onClick={() => setEditing(template)}
                      >
                        {template.title}
                      </Button>
                      <span className="text-xs text-muted-foreground">{template.description}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Rules in evaluation order</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1">
                    Order
                  </th>
                  <th scope="col">Priority</th>
                  <th scope="col">Name</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Dropped (7 days)</th>
                  <th scope="col">
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((rule, index) => (
                  <tr key={rule.id} className="border-t">
                    <td className="py-2">{index + 1}</td>
                    <td>{rule.priority}</td>
                    <td>
                      {rule.name}
                      {!rule.enabled && (
                        <span className="ml-2 text-xs text-muted-foreground">(disabled)</span>
                      )}
                    </td>
                    <td>{rule.stage}</td>
                    <td>{summarize(rule)}</td>
                    <td>{drops ? (drops.byRule[rule.id] ?? 0) : "–"}</td>
                    <td className="flex flex-wrap justify-end gap-1 py-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                        disabled={toggle.isPending}
                        onClick={() => {
                          setActionError(null);
                          toggle.mutate(rule);
                        }}
                      >
                        {rule.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${rule.name}`}
                        onClick={() => setEditing(rule)}
                      >
                        Edit
                      </Button>
                      {confirmDelete === rule.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            aria-label={`Confirm delete ${rule.name}`}
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(rule.id)}
                          >
                            Confirm delete
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${rule.name}`}
                          onClick={() => setConfirmDelete(rule.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {drops && (
              <p className="text-sm text-muted-foreground">
                Dropped by the default policy (no rule decided), last 7 days:{" "}
                <strong>{drops.defaultPolicy}</strong>
              </p>
            )}
          </>
        ))}
    </main>
  );
}
