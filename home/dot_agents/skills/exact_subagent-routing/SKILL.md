---
name: subagent-routing
description: Subagent routing — picks the harness, model, effort and spawn tool for every agent you start. Load before spawning any subagent, delegate, workflow agent, reviewer, council member or second opinion (Agent, Workflow, delegate_task, spawn_agent or a CLI), and when asked which models or harnesses exist.
---

# Subagent routing

Every agent you start gets **routed**: a task type maps to one family, one
model and one effort level, set explicitly. An agent you do not route
inherits your own model. That is the failure this skill exists to stop:
an Opus thread that only ever spawns Opus.

## 1. Decide whether to spawn

Do the work yourself when it is a handful of tool calls, a lookup whose
target you know, or a small fix from a review. Spawn for independent
parallel work, broad reading you only need the conclusion of, a builder
on a scoped change, or an independent review.

Done when: you can name the task type from the table in step 2.

## 2. Route by task type

Pick the newest version of each family in the live list (step 3). The IDs
below are as of 2026-11-05.

| Task type | Family and model | Harness | Effort |
| --- | --- | --- | --- |
| Orchestration, planning, design synthesis, final call | stays in the main thread | — | — |
| Build a scoped change (feature, fix, refactor) | GPT Sol `gpt-6.1-sol` | Codex | high |
| Hard bug or root cause | GPT Sol `gpt-6.1-sol` | Codex | xhigh |
| Code review, adversarial verify | one reviewer from a family other than the builder's: GPT Sol `gpt-6.1-sol` for Claude-built work, Opus `claude-opus-5-5` for GPT-built work, Muse Wonder Full `muse-wonder-full-1.0` otherwise. Add a second family only for security, auth, data loss or concurrency | Codex, Claude Code, Muse Code | high |
| Architecture or design second opinion | Muse Wonder Full `muse-wonder-full-1.0` | Muse Code | high |
| Copy, docs, UI text | Muse Wonder Full `muse-wonder-full-1.0` | Muse Code | medium |
| Bulk mechanical edits (renames, codemods, many-file sweeps) | GPT Luna `gpt-6-luna` or Muse Spark `muse-spark-1.3` | Codex, Muse Code | low |
| Read-only fan-out: codebase search, file reading, web research | Claude Sonnet `claude-sonnet-5-5`; Haiku `claude-haiku-5-5` for pure lookups | Claude Code | medium |
| Tie-breaker or third opinion | Grok `grok-4.7` | Grok | high |
| Merge gate on a PR | the `council` skill | — | — |

Rules that override the table:

- **The user names a model**: use that model.
- **A named workflow skill wins** (`council`, `sol-loop`, `full-send`,
  `pr-workflow`): its reviewer count, models, tools and family rules replace
  this table for that step.
- **Cross-family review**: the reviewer's family always differs from the
  builder's. A Claude-built change gets GPT or Muse review; a GPT-built
  change gets Claude or Muse review.
- Use Muse Wonder Full for Wonder-class work. Skip the `-contributor`
  variants unless the user asks.
- Skip image, video, voice and TTS models for coding and review.

Done when: every agent you are about to start has a family, a model ID and
an effort level written in its spawn call.

## 3. Spawn with the right tool

The spawn tool follows the target family, not your own.

**In T3 Code:**

1. Call `orchestrator_capabilities` once per thread. It lists every enabled
   harness, model ID and allowed effort value. If a model is missing, call
   it again with `search`.
2. Target in **your own family**: use your native tool (Claude `Agent` or
   `Workflow`, Codex `spawn_agent`) with the model and effort set. Use
   `delegate_task` instead when the child needs settings the user asked
   for, its own checkout (`isolation: "worktree"`), or to run in the
   background.
3. Target in **any other family**: call `delegate_task` with
   `target.providerInstanceId`, `target.model`, the effort in
   `target.options` (`{effort: ...}` on `claudeAgent`,
   `{reasoningEffort: ...}` on `codex`, `grok` and `muse`) and a `role`.
   Give each builder that edits in parallel with another
   `isolation: "worktree"`. Start parallel delegates in one message, then
   follow each delegate's `next` and wait for its notification.

Provider IDs and home harnesses:

| Family | Home harness | T3 provider ID |
| --- | --- | --- |
| Claude (Opus, Sonnet, Fable, Haiku) | Claude Code | `claudeAgent` |
| GPT (Sol, Astra, Luna, Terra) | Codex | `codex` |
| Grok | Grok | `grok` |
| Muse (Wonder Full, Wonder, Spark) | Muse Code | `muse` |

Codex and Grok also list other families through a proxy. Always target the
home harness.

**Claude Code only: workflows mix with delegates by phase.** A `Workflow`
script's `agent()` starts only Claude agents, and its children start no
subagents. When the user or CLAUDE.md has opted into workflows, run
Claude-routed fan-out (search, read, research) as a workflow, and run
other-family stages (build, review) as `delegate_task` calls from the main
thread, between workflows.

**Outside T3 Code**, run the target harness's headless CLI. Check `--help`
for current flags:

| Harness | Run one prompt |
| --- | --- |
| Claude Code | `claude -p "<prompt>" --model <id>` |
| Codex | `codex exec -m <id> "<prompt>"` |
| Grok | `grok -p "<prompt>" -m <id> --effort <level>` |
| Muse Code | `muse exec --model <id> "<prompt>"` |

**A model or harness is unavailable**: report it and hold the steps that
depend on it. Switch to another model or a proxy route only when the user or
a named workflow skill allows a substitute. The live list is the authority
over the IDs in this file.

Done when: each spawn call names its target model, and every other-family
target went through `delegate_task` or its harness CLI.

## 4. Brief the agent

A delegate sees none of your conversation. Give it:

- the goal, and what you have already ruled out
- the files or links to read
- whether it may edit files (reviews are read-only)
- the repo's review rules, when it builds a PR (see `pr-workflow`)
- what to return

Report which model did which job in your reply to the user.
