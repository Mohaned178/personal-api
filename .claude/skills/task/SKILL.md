---
name: task
description: Run one Personal API task from docs/PLAN.md end to end (for example "/task M1-05"). It reads the task's [model · effort] tag and delegates to builder, test-writer and reviewer subagents at that model and effort, so the user never switches /model or /effort. Use when the user asks to do, run or implement a task ID such as M0-03 or M2-R.
argument-hint: <task-id> [auto-merge]
---

# /task: run one plan task with automatic model and effort routing

You are the **coordinator**. You don't write feature code or tests yourself. You route, verify and handle git. Arguments: `$ARGUMENTS`, meaning a task ID such as `M1-05` or `M1-R`, optionally followed by `auto-merge`.

## 1. Look up the task

- Find the line `- [ ] **<ID> [<M> · <effort>] …**` in `docs/PLAN.md` §10.
- Model letter mapping: `H` → `haiku`, `S` → `sonnet`, `O` → `opus`.
- If the box is already ticked, or the ID is missing, stop and tell the user.
- If an earlier task in the same milestone is still unticked, warn the user and ask before continuing. Tasks are ordered on purpose.

## 2. Prepare the branch

- `git switch main && git pull --ff-only`, then `git switch -c <id-lowercase>-<short-name>`, for example `m1-05-ingest-endpoint`.
- `Mx-R` review tasks don't get a branch. They review `main` (see step 3).

## 3. Delegate by tag

Always call the Agent tool with **explicit `subagent_type`, `model` and `effort`**, exactly as listed below. Give every subagent the task ID, the branch name, and a pointer to `CLAUDE.md` and `docs/PLAN.md`. Subagents start cold, so say what already exists, for example "tests were written in the previous step, in these files: …".

| Tag | Calls, in order |
| --- | --- |
| `[H · e]` | `builder`, model `haiku`, effort `e` |
| `[S · e]` | `builder`, model `sonnet`, effort `e` |
| `[O · e]` | 1. `test-writer`, model `sonnet`, effort `high`. Commit its tests on the branch (`test(<scope>): failing tests for <ID>`). 2. `builder`, model `opus`, effort **`medium`** (always, whatever `e` says), told that the tests exist and must not be weakened. 3. After the PR is open, `reviewer`, model `opus`, at the task review effort (below), scope `main...<branch>`. |
| `[H · e] {deepseek}` / `[S · e] {deepseek}` | DeepSeek implements through OpenCode, Opus reviews. See "DeepSeek tasks" below. |
| `Mx-R` | `reviewer`, model `opus`, effort `e`. Scope: every commit merged for milestone Mx (find them with `git log --oneline` and the task branch names). |

**Opus never implements above `medium`.** `high` and `xhigh` are for the `reviewer` only.

**Task review effort** (per-task `reviewer` on `opus`): `medium` when the tag's effort is `low` or `medium`; `high` when it is `high`, or when the task touches auth, sessions, keys, tenant scoping, URL sanitizing, rule enforcement or another privacy invariant in `CLAUDE.md`. Full reviews (`Mx-R`, the security pass) use their tag: `high` or `xhigh`.

For `Mx-R`: when there are blockers or should-fix findings, report them to the user and offer to open fix tasks. Don't fix them silently. When the verdict is `approve`, tick `Mx-R`.

### DeepSeek tasks (`{deepseek}` after the tag)

Don't ask the user which model to use. The lane is fixed: `deepseek` in the global delegate config (`opencode/deepseek-v4.1-flash-free`, variant `max`).

1. **Tests first, on `[S]` tasks only:** `test-writer`, model `sonnet`, effort `e`, from the task's "done when" criteria (and a cross-tenant test for any new route). Commit them (`test(<scope>): failing tests for <ID>`). `[H]` tasks (scaffold, docs, packaging, polish) skip this.
2. **Implement:** load the `opencode-delegate` skill and dispatch with its relay, in the background: `--lane deepseek --cd <repo> --timeout 2h`. Write the brief per that skill. It must include the task line from `docs/PLAN.md`, the plan sections it relies on, a pointer to `CLAUDE.md` (invariants and conventions), the gate commands from step 4, "don't commit", "don't add dependencies the plan doesn't name", and, if tests exist, "make these tests pass; never edit, skip or weaken them".
3. **Verify** (step 4). If the checks fail, send one delta brief with `--resume-last`. If they still fail, fall back to the normal row for the tag (`builder` on `haiku`/`sonnet` at `e`) with the failure output and the diff so far, then follow the escalation ladder.
4. **Review:** after the PR is open, `reviewer`, model `opus`, at the task review effort, scope `main...<branch>`. This review is mandatory for every DeepSeek task.

## 4. Verify (never trust "done" alone)

After the builder reports, run these yourself and read the output:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Until M0-01 and M0-08 exist, some of these scripts won't. Run whatever the repo has, and check M0-01's own "done when" command instead.

Add `pnpm test:int` if the task touched the DB and Docker is running, and `pnpm test:e2e` for e2e tasks. If something you couldn't run locally will only run in CI, say so.

**Escalation ladder.** Apply it when checks fail or the builder reports `blocked`:
1. Send the failure output back to the same builder (SendMessage), for one fix attempt.
2. If it still fails, start a new `builder` one level up (`haiku` → `sonnet`, `sonnet` → `opus` at `medium`) with the failure output and the diff so far. Opus at `medium` is the top of the ladder: there's no higher-effort Opus builder.
3. If that fails too, or Opus `medium` fails, or a subagent reports `needs-opus` on a design, auth, tenant-scoping or invariant question that the next level can't settle, **stop and ask the user**. Include the evidence.

A builder status of `needs-opus` from Haiku or Sonnet goes straight to step 2.

## 5. Ship

1. Tick the task's checkbox in `docs/PLAN.md` on the branch, so the tick merges together with the work. Then commit with a Conventional Commit message, ending with the attribution trailer Claude Code gives you.
2. Push the branch and open a PR to `main`. The PR body gives the task ID, a summary, the checks run (with results), and anything not run locally.
3. For `[O]` and `{deepseek}` tasks: run the reviewer (step 3).
   - On `blocker` or `should-fix`: send the findings to a `builder` on `opus` at effort `medium`, re-verify, push, and re-review once (`reviewer`, `opus`, same review effort).
   - Open `follow-up` findings as GitHub issues.
4. Wait for CI (`gh pr checks --watch`).
5. **Merge:**
   - Without `auto-merge`, ask the user to approve the squash-merge.
   - With `auto-merge`, merge (`gh pr merge --squash --delete-branch`) only when CI is green and there are no unresolved blockers.
6. Never commit to `main` directly. If the user declines the merge, the tick stays unmerged with the work.

## 6. Report

Give the user a short summary:
- the task
- which model and effort did each step (including any escalation)
- the PR link
- the check results, and anything not verified locally
- follow-up issues opened

Keep it short. The user prefers light ceremony.
