# Issue threads: one T3 thread per issue

Use this in T3 Code when the user asks you to implement one or more GitHub
issues, or the tickets of a Linear milestone. Each issue gets its own
top-level **issue thread**: its own worktree, Opus builder, PRs and
settlement. Three issues make three threads; a ten-ticket milestone makes
ten. The global rules make this the default in every project and record the
owner's standing permission to create those threads.

The batch is exactly what the user named. Watching for new issues, acting on
labels or running on a schedule is a different job; start it only when the
user asks for it by name.

Your thread is the **orchestrator**. It creates and briefs the issue
threads, runs their reviews, starts dependents and reports. Each issue
thread builds, opens and links its own PRs.

## 1. Enumerate the batch

- GitHub: `gh issue view <n> --repo <owner>/<repo> --json
  number,title,body,url,state` for each issue the user named.
- Linear: resolve the project from the request or paginated `list_projects`
  with `includeMilestones: true`; clarify ambiguous matches. Call
  `get_milestone` with that `project` and the milestone's `query`, then
  `list_issues` with that `project` and `fields` including
  `projectMilestone`, passing `cursor` while `hasNextPage` is true. Keep the
  tickets whose `projectMilestone` is the named one. Then `get_issue` with
  `includeRelations: true` for each ticket's description and blockers.

For every issue record its **key** (`<owner>/<repo>#<n>` on GitHub, the
identifier such as `ABC-123` on Linear), title, URL, body, acceptance
criteria and the keys it depends on. Leave out closed or completed issues
and say which.

Done when: every named issue has a key, acceptance criteria and a dependency
list, and the set matches what the user asked for.

## 2. Find each issue's existing thread

T3 has no issue field on a thread. The key lives at the start of the thread
title, `<key>: <issue title>`, and in the branch `issue/<slug>`: GitHub
`issue/<repo>-<n>` (`issue/web-42`), Linear the lowercased identifier
(`issue/abc-123`). Look up every key before creating anything:

1. `t3_project_list` (page with `cursor`) for the repo's `projectId`.
2. `t3_thread_list` with that `projectId` and `titleContains: "<key>: "`,
   once with `settled: false` and once with `settled: true`. Pass
   `nextCursor` back as `cursor` until it is absent. Keep only titles that
   **start** with `<key>: `.
3. `t3_thread_search` with the branch name, as a second look. It is not
   exhaustive, so it never proves a thread is absent on its own.

| What you find | Do this |
| --- | --- |
| One active thread | Reuse it |
| One settled thread, the issue still open | Reuse it: the brief you send in step 4 wakes it |
| One settled thread, the issue closed | Report it as done; create nothing |
| Several threads | Reuse the newest; list the others for the user |
| None | Create one (step 3) |

A message (`t3_thread_send`) clears a thread's settled state and keeps T3's
auto-settle on. `t3_thread_organize` `unsettle` instead pins the thread
active, and T3 never auto-settles it until it gets another message, so
reactivate threads by messaging them.

Before resuming, `t3_thread_read` the reused thread. Set the routed builder
with `t3_thread_configure` and step 3's `modelSelection`. If it lacks its own
worktree, send only a setup brief: call `t3_worktree_handoff` on branch
`issue/<slug>` with the implementation brief as `continuationPrompt`; make
no code edits before the move. Preserve any existing work and report
conflicts instead of replacing its checkout.

Done when: every issue maps to exactly one thread, reused or to be created.

## 3. Create the threads

Call `t3_thread_launch` once per issue that has no thread:

- `projectId`: the repo's project; `title`: `<key>: <issue title>`.
- `clientRequestId`: `issue-thread:<key>:<batch start date, UTC>`. Retry
  with the same value after an error or a lost reply.
- `workspaceStrategy`: `{type: "worktree", branch: "issue/<slug>",
  baseRef: "origin/<default branch>"}`.
- `modelSelection`: the builder route from `subagent-routing`: `{instanceId:
  "claudeAgent", model: "claude-opus-5-5", options: [{id: "effort", value:
  "high"}]}` (`"xhigh"` for a hard bug).
- `message`: the brief (step 4) when the issue starts now. Leave it out for
  an issue that waits: the thread is created idle.

**Capacity.** At most three issue threads build at once unless the user
sets another number. A slot frees when an issue thread hands back its PR.
An issue starts when a slot is free and every issue it depends on has
merged; its brief then goes out with `t3_thread_send`, and tells it to
rebase onto the current default branch before its first edit.

Done when: every issue has a thread and no more than the capacity are
building.

## 4. Brief each issue thread

The brief opens with: "You are a builder launched for this task: do the job
yourself and start no agents or threads." Then:

- the issue key, URL, title and full body, and the acceptance criteria as a
  checklist the PR must meet
- each dependency's key and merged PR
- its branch, and the repo's rules for the paths it touches (`pr-workflow`
  section 2: `.coderabbit.yaml` path instructions, pre-push checklist, size
  limit, sensitive paths)
- **First hand-back:** build, commit, run the repo's local gate (and the
  CodeRabbit CLI where the repo has `.coderabbit.yaml`) on the committed
  head, then report the head SHA and results. Open no PR yet.
- **After "reviews clean at <sha>":** open the PR per `pr-workflow`
  section 4, link it from its own thread with `link_pull_request` (no
  `threadId`; `link_pull_requests` for several), land it with `land-pr`,
  comment the PR link on the issue or ticket and set its status, and report
  the PR URL and the `land-pr` outcome.

## 5. Review before the PR opens

When an issue thread reports a gated head (`t3_thread_wait`; on a timeout
that returns `next`, end your turn), route its review from your thread per
`subagent-routing`: one focused reviewer by default, the review panel only
for complex or sensitive work. Reviewers are read-only `delegate_task` children reading the
branch `issue/<slug>` against its merge base (`t3_thread_launch` reviewers
when the repo is another project). Send the findings to the issue thread
with `t3_thread_send`; it fixes, regates and reports a new head, and the new
range gets a fresh review. When it is clean, send "reviews clean at
<sha>".

## 6. Track, settle and clean up

T3 settles an issue thread by itself; agent-env keeps
`sidebarAutoSettleOnMerge` on in T3's settings. A project override
(`projectSettingsOverrides.<projectId>.sidebarAutoSettleOnMerge: false`)
turns it off for that repo: there, settle each issue thread with
`t3_thread_organize` `settle` once its last PR merges.

- **Every PR link names its issue thread.** A link made inside the issue
  thread lands there. From your thread, pass the issue thread's
  `threadId`, so your thread stays active.
- A thread settles once none of its linked PRs is open and the last one
  merged or closed (a closed, unmerged PR settles it too).
- **Several PRs for one issue:** when more PRs are still to come, `pin` the
  issue thread before its first PR merges (a pinned thread never
  auto-settles), and `unpin` it once the final PR is linked.
- A thread that is running, or holds queued messages or background work,
  settles once that finishes. A thread that got a user message after the
  merge stays active: settle it with `t3_thread_organize` `settle` when its
  work is done.
- **Dependents:** `land-pr` may hand back at `QUEUED`, before the merge.
  When a waiting issue depends on a queued PR, `watch_pull_request` that PR
  once from your thread (one watch per blocking PR, however many issues
  wait on it), end your turn, and on the merge `unwatch_pull_request` and
  start the dependents. Nothing else polls.
- **Bounces** follow `pr-workflow` section 4; when you handle one, send the
  fix to the issue thread.
- **Clean up** per `pr-workflow` section 7 once each PR merges.

Report each issue's thread `link`, PR and `land-pr` outcome to the user.
The batch is done when every issue's PRs have merged (or a `REFUSED` was
reported), every issue thread has settled, and no watch you set remains.
