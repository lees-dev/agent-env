---
name: subagent-routing
description: Subagent routing — picks the harness, model, effort and spawn tool for every agent you start. Load before spawning any subagent, delegate, workflow agent, reviewer, council member or second opinion (Agent, Workflow, delegate_task, spawn_agent or a CLI), and when asked which models or harnesses exist.
---

# Subagent routing

Every agent you start gets **routed**: a task type maps to one family, one
model and one effort level, set explicitly. An agent you do not route
inherits your own model. That is the failure this skill exists to stop:
a thread that only ever spawns its own model, or writes code it should
have handed to the builder.

## 1. Decide whether to spawn

**If `delegate_task` started you, do your assigned job yourself.** Do not
start agents, panels or councils unless your brief says to. The rest of
this skill is for the main thread.

The main thread orchestrates: it plans, briefs, routes, judges review
findings and makes the final call. New threads default to GPT Sol at
medium effort, so the main thread is usually not the builder.

- **Code goes to the builder.** Writing or changing code for a scoped
  change (feature, fix, refactor, hard bug, conflict resolution, review
  fixes) is Opus's job (step 2). If you are not Opus, delegate it to Opus.
  If you are Opus, build it yourself.
- **A small fix you may make yourself**: up to about 20 changed lines in one
  or two files, with no new behavior (a review nit, a typo, a config value,
  a one-line guard). Anything larger goes to Opus.
- Do the work yourself when it is a handful of tool calls or a lookup whose
  target you know.
- Spawn for independent parallel work, broad reading you only need the
  conclusion of, the builder on a scoped change, a review, or a council on
  an unresolved design trade-off.

Done when: you can name the task type from the table in step 2.

## 2. Route by task type

Pick the newest version of each family in the live list (step 3). The IDs
below are as of 2026-11-06.

| Task type | Family and model | Harness | Effort |
| --- | --- | --- | --- |
| Orchestration, planning, design synthesis, final call | stays in the main thread (default GPT Sol `gpt-6.1-sol`) | — | medium |
| A genuine unresolved design trade-off (investigation leaves viable approaches the evidence does not settle), or the user asks for a council | the planning council (see rules): Opus `claude-opus-5-5`, GPT Sol `gpt-6.1-sol`, Muse Wonder Full `muse-wonder-full-1.0-contributor` and Grok `grok-4.7` | Claude Code, Codex, Muse Code, Grok | high |
| Build a scoped change (feature, fix, refactor) | Opus `claude-opus-5-5` | Claude Code | high |
| Hard bug or root cause | Opus `claude-opus-5-5` | Claude Code | xhigh |
| Review of Opus-built complex new behavior, or a sensitive path (security, auth, data, migrations, concurrency, CI) | the review panel (see rules): GPT Sol `gpt-6.1-sol` (high), Muse Wonder Full `muse-wonder-full-1.0-contributor` (xhigh), Grok `grok-4.7` (high), Sonnet `claude-sonnet-5-5` (high) | Codex, Muse Code, Grok, Claude Code | as listed |
| Review of other Opus-built work, including routine fixes whatever their line or file count | GPT Sol `gpt-6.1-sol` | Codex | high |
| Review of work built by another family | one reviewer from another family: Opus `claude-opus-5-5` for GPT-built work, GPT Sol `gpt-6.1-sol` otherwise. Add a second family for security, auth, data loss, migrations or concurrency | Claude Code, Codex | high |
| Adversarial verify of one claim or finding, or a tie-break on a disputed blocker | GPT Sol `gpt-6.1-sol`, a fresh delegate scoped to that one claim | Codex | high |
| Copy, docs, UI text | Muse Wonder Full `muse-wonder-full-1.0-contributor` | Muse Code | medium |
| Bulk mechanical edits (renames, codemods, many-file sweeps) | GPT Luna `gpt-6-luna` or Muse Spark `muse-spark-1.3-contributor` | Codex, Muse Code | low |
| Read-only fan-out not feeding a plan: codebase search, file reading, fact lookups, audits | Claude Sonnet `claude-sonnet-5-5`; Haiku `claude-haiku-5-5` for pure lookups | Claude Code | medium |
| A repo's lander (the `land-queue` schedule, see `pr-workflow` section 4) | Claude Sonnet `claude-sonnet-5-5` | Claude Code | medium |
| Third opinion outside a panel | Grok `grok-4.7` | Grok | high |
| Merge gate on a PR | the review row that fits the change (panel or single reviewer) | — | — |

Rules that override the table:

- **The user names a model or a skill**: use it. `council` (when the user
  says "council"), `sol-loop` and `how` set their own members and models
  for their step. `pr-workflow`, `full-send` and the other PR skills do
  not: their reviews follow this table.
- **Cross-family review**: at least one reviewer's family differs from the
  builder's. In the review panel GPT, Muse and Grok are the cross-family
  reviewers and Sonnet is the extra same-family read.
- **The review panel**: start all four reviewers in one message,
  read-only, with the same brief and diff. A finding is real when a
  reviewer backs it with evidence (file:line, a failing test, output), not
  by vote count. When reviewers disagree on a blocker, run one fresh Sol
  delegate scoped to that claim; if it is still open, put both sides'
  evidence to the user. A reviewer that is unavailable is reported, not
  replaced; the panel still needs at least one cross-family reviewer.
  Fixes from the panel go to Opus (step 1), then the changed code gets a
  fresh review.
- **The planning council**: for a genuine unresolved design trade-off (table),
  all four families take part through `delegate_task`, in parallel and
  read-only: Opus (`effort: "high"`), Sol (`reasoningEffort: "high"`),
  Muse Wonder Full (`reasoningEffort: "high"`) and Grok 4.7
  (`reasoningEffort: "high"`). Give each the same brief; ask for its own
  research, proposal, risks and open questions. The main thread compares
  them, grafts the best ideas onto the strongest proposal, says who
  proposed what, and returns the plan; if members split and the evidence does
  not settle it, ask the user. Planning ends there: building and
  reviewing start only when the user or the task authorizes them. Sonnet
  fact-finding may run first to build the shared brief. A request to plan,
  a new feature, a migration or a spec does not by itself call a council:
  investigate first, and when the evidence settles the approach the main
  thread writes the plan. A member that is unavailable is reported, not
  replaced.
- **Gemini is not used.** Where a source (for example Theo's setup) lists
  Gemini, Grok `grok-4.7` takes that seat.
- Use Muse Wonder Full for Wonder-class work. For every Muse model, target
  its `-contributor` variant (same family, same effort); use the regular ID
  only when the user names it or the live list lacks the variant.
- Skip image, video, voice and TTS models for coding and review.

Done when: every agent you are about to start has a family, a model ID and
an effort level written in its spawn call.

## 3. Spawn with the right tool

**In T3 Code, every agent you start goes through `delegate_task`.** That
covers builders, reviewers, research and search fan-out, council members and
second opinions, whatever the family, your own included. Do not use Claude
`Agent`, `Workflow` or `Task`, or Codex `spawn_agent`, inside T3. A delegate
is its own T3 thread that shows its model, so the user can see who did what.
The one exception is work in another repo, which `delegate_task` cannot
reach (see "Work in another repo" below).
(In Claude Code a hook denies `Agent`/`Workflow`/`Task` inside T3.)

1. Call `orchestrator_capabilities` once per thread. It lists every enabled
   harness, model ID and allowed effort value. If a model is missing, call
   it again with `search`. Always set effort: defaults can be low (Sol
   defaults to `low`).
2. Call `delegate_task` with
   `target.providerInstanceId`, `target.model`, the effort in
   `target.options` (`{effort: ...}` on `claudeAgent`,
   `{reasoningEffort: ...}` on `codex`, `grok` and `muse`) and a `role`
   (`implementation`, `research`, `review`, `design`, `test` or `general`).
   Give each builder `isolation: "worktree"` (a new checkout of the parent
   commit, on its own branch). `delegate_task` reaches only this thread's
   own project; for another repo see "Work in another repo" below. Start parallel delegates in one message, then follow each
   delegate's `next` and wait for its notification. Do not poll
   (`task_status`, `sleep`, `Monitor`). Stop a delegate you replace or no
   longer need with `task_cancel`. T3 tools may be deferred: load them
   before deciding `delegate_task` is missing.
3. The usual calls from a Sol main thread:
   - **Opus builder**: `delegate_task` with `target: {providerInstanceId:
     "claudeAgent", model: "claude-opus-5-5", options: {effort: "high"}}`
     (`xhigh` for a hard bug) and `role: "implementation"`.
   - **Review panel**: four `delegate_task` calls in one message, each
     with `role: "review"`: `codex` / `gpt-6.1-sol` with
     `{reasoningEffort: "high"}`; `muse` /
     `muse-wonder-full-1.0-contributor` with `{reasoningEffort: "xhigh"}`; `grok` /
     `grok-4.7` with `{reasoningEffort: "high"}`; `claudeAgent` /
     `claude-sonnet-5-5` with `{effort: "high"}`.
   - **Planning council**: four `delegate_task` calls in one message, each
     with `role: "design"` (or `"research"`): `claudeAgent` /
     `claude-opus-5-5` `{effort: "high"}`; `codex` / `gpt-6.1-sol`
     `{reasoningEffort: "high"}`; `muse` / `muse-wonder-full-1.0-contributor`
     `{reasoningEffort: "high"}`; `grok` / `grok-4.7`
     `{reasoningEffort: "high"}`.
   - **Research fan-out** (not feeding a plan): one `delegate_task` per
     angle, `role: "research"`, `claudeAgent` / `claude-sonnet-5-5` with
     `{effort: "medium"}` (Haiku for pure lookups), started in one message.

Provider IDs and home harnesses:

| Family | Home harness | T3 provider ID |
| --- | --- | --- |
| Claude (Opus, Sonnet, Fable, Haiku) | Claude Code | `claudeAgent` |
| GPT (Sol, Astra, Luna, Terra) | Codex | `codex` |
| Grok | Grok | `grok` |
| Muse (Wonder Full, Wonder, Spark) | Muse Code | `muse` |

Codex and Grok also list other families through a proxy. Always target the
home harness.

**Work in another repo** (another T3 project): `delegate_task` only starts
children in the starting thread's own project. Start that builder or
reviewer with `t3_thread_launch` instead: `projectId` of that repo's T3
project (`t3_project_list`; clone and register it first if missing),
`workspaceStrategy: {type: "worktree", branch: "<branch>", baseRef:
"origin/<base>"}`, `modelSelection` set from the table (builder:
`{provider: "claudeAgent", model: "claude-opus-5-5", options: {effort:
"high"}}`), a `title`, and the full brief in `message`. The brief opens
with "You are a builder/reviewer launched for this task: do the job
yourself and start no agents or threads". Then `t3_thread_wait` (on a
timeout with `next`, end the turn) and `t3_thread_read` for the result;
never poll in a loop. Stop such a thread with `t3_thread_interrupt` (not
`task_cancel`). The parent keeps responsibility for its reviews: route
them as for any other build. This is an allowed exception to "new
top-level thread only when the user asks". Mention the thread by its
`link`.

**Phased work in T3** (understand → design → implement → review) runs
each phase as a set of `delegate_task` calls from the main thread, not as a
`Workflow`; for phased work in another repo, each phase's agents are
`t3_thread_launch` threads in that repo's project (as above). Read each
phase's results before starting the next.

**An issue batch in T3** (the user asks you to implement named GitHub
issues, or a Linear milestone's tickets): one top-level issue thread per
issue, not a delegate. Follow `references/issue-threads.md`.

**Outside T3 Code** (no T3 tools listed): for your own family use your
native tool with the model set (Claude `Agent`, or `Workflow` for read-only
fan-out; Codex `spawn_agent`). For another family run its headless CLI.
Check `--help` for current flags:

| Harness | Run one prompt |
| --- | --- |
| Claude Code | `claude -p "<prompt>" --model <id>` |
| Codex | `codex exec -m <id> "<prompt>"` |
| Grok | `grok -p "<prompt>" -m <id> --effort <level>` |
| Muse Code | `muse exec --model <id> "<prompt>"` |

**A model or harness is unavailable**: report it and hold the steps that
depend on it. Switch to another model or a proxy route only when the user or
a named skill allows a substitute (`council` lets Grok replace an
unreachable reviewer). The live list is the authority over the IDs in this
file.

Done when: each spawn call names its target model and effort, and in T3
every agent went through `delegate_task` (or `t3_thread_launch` for work in
another repo).

## 4. Brief the agent

A delegate sees none of your conversation. Give it:

- the goal, and what you have already ruled out
- the files or links to read
- whether it may edit files (reviews and planning are read-only)
- that it must not start agents of its own, unless you want it to
- the repo's review rules, when it builds a PR (see `pr-workflow`)
- what to return

Report which model did which job in your reply to the user.
