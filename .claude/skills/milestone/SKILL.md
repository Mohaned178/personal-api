---
name: milestone
description: Run a whole Personal API milestone from docs/PLAN.md (for example "/milestone M1" or "/milestone M1 auto-merge"). It refines the tasks with Opus, runs every unchecked task in order through the /task routing (automatic model and effort per tag), then runs the Mx-R review. Use when the user asks to do, run or start a milestone.
argument-hint: <milestone-id> [auto-merge]
---

# /milestone: run every task in a milestone

You are the **coordinator**. Arguments: `$ARGUMENTS`, meaning a milestone such as `M1`, optionally followed by `auto-merge`.

## 1. Refine the plan (once per milestone)

Before running any task, spawn the `Plan` agent with model `opus` and effort `high`. Tell it to:
- Read `CLAUDE.md`, `docs/PLAN.md` and the code that exists now.
- Check the milestone's tasks against reality: missing prerequisites, tasks to split or merge, "done when" criteria that are now wrong, and tags (`[model · effort]`) that no longer fit.
- Return a proposed diff to §10 for this milestone only.

Show the user the proposed changes in a few lines and ask for approval. Apply what they approve to `docs/PLAN.md` (it rides along with the first task's branch). If there are no changes, say so and continue.

## 2. Run the tasks

Run the milestone's unticked tasks **in order**, one at a time. For each one, follow `.claude/skills/task/SKILL.md` exactly (lookup, branch, delegate by tag, verify, escalate, ship). Pass `auto-merge` through if it was given.

- Each task must be merged before the next starts, because later tasks build on earlier ones.
- If a task ends in "stop and ask the user", pause the milestone, report where you stopped, and wait.
- Between tasks, post a single progress line, for example `M1-03 ✓ (opus · medium) PR #12 merged; next M1-04 (deepseek · max)`. No tables.

## 3. Review

When every task is ticked, run `Mx-R` (the tagged effort, `reviewer` on `opus`) over the whole milestone.
- On `approve`: tick `Mx-R`.
- On anything else: report the findings and propose fix tasks. Don't fix them without the user's approval.

## 4. Close out

Report:
- the milestone's tasks with the model and effort each one used (one line each)
- the PR links
- escalations that happened
- follow-up issues opened
- anything not verified locally

Ask before tagging a release or touching repo settings. Those always need the user.
