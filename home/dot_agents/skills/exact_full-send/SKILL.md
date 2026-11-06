---
name: full-send
description: Trigger this if the user says 'full send'.
---

# Full Send

If the user triggered this, it's because they are not watching this thread, and
they want you to complete the work end-to-end autonomously. Your updates and
your final message go unread until long after you stop. You own the work from
its current state to a merged PR, including a PR that waits in the land queue.

If the user did not explicitly request "full send" in some clear way, do not
assume full autonomy. If they did, everything below applies.

The user grants you permission to:

- Land the PR with `land-pr` once the merge gate passes.
- Force-push the PR's own branch with `--force-with-lease` after a rebase.
- Use the test methods that Proof needs, without asking first.

## Testing permission

A "full send" request is the permission. If a project file or other
instruction says to ask before a test method, or to leave testing to the
user, this request replaces that rule for this task.

That includes ask-first rules for computer use, browser automation,
simulators and devices, running the app or a dev server, screenshots, and
visual checks. Use the method that gives direct proof, and in T3 Code use
T3's tool for it: the preview tools for browser work, the device tools for
simulators and emulators. List it in the
report.

Rules about how to test still apply. Follow rules that name the correct
command, fixture, or check. This permission only removes the ask-first or
leave-it-to-the-user step. If a preferred method cannot prove the change,
use a gated method under this permission.

It covers only the tests needed for this task. It does not add permission
for the steps under "Asking the user", such as production changes or data
deletion. It also does not bypass a harness or system approval prompt if
one appears.

## Steps

1. **Finish the change.** Complete the goal from the user's request with the
   smallest change that works. Fix the case that happened, not every case
   that could. If you are on the default branch, create a branch first. If
   you are not Opus, the code (and every later fix beyond a small fix) goes
   to an Opus builder through `delegate_task` (see `subagent-routing`); you
   orchestrate, prove, gate and land.
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Get feedback.** Use the `sol-loop` skill to verify changes. Skip this
   step when step 4's review already covers the change: the four-model panel
   for a larger Opus-built change, or the single Sol review for a small one.
4. **Run the local gate.** Rebase onto the latest default branch, then run
   the gate (see `pr-workflow`): lint, typecheck, build, reached tests and
   specs, CodeRabbit CLI once where present, the cross-family review
   `subagent-routing` sets (the four-model panel for larger Opus-built
   changes). Fix
   every Critical, Major, P0, P1. Prove each fix before pushing it.
5. **File the PR** with the `file-pr` skill (in T3 Code it links the PR with
   `link_pull_request`). Add one short line to the
   description that says how you proved the change, with the local results.
6. **Land it** when the merge gate passes: `land-pr <n> --sha <gated sha>`,
   following `pr-workflow` section 4 (outcomes, the lander kick, the
   fallback). You are done only at `MERGED`. On `QUEUED` / `QUEUE-FULL`:
   in T3, call `watch_pull_request` and end the turn. The lander handles a
   bounce with its own fixer; act on a bounce only when the PR is parked
   (two lander attempts used: `queue-blocked` plus a comment starting
   `PARKED:`) or the lander reports it cannot start a fixer: then read its
   comment, fix (Opus), and re-land per "Editing a
   queued PR". On `REFUSED <reason>`, fix the reason if it is this task's,
   otherwise ask the user. Once it is `MERGED`, call `unwatch_pull_request`
   and go on.
7. **Clean up** (`pr-workflow` section 7), then **report** in your final
   message: the PR link, the merge commit, your proof, what was cleaned up,
   and each decision you made for the user.

Stay active from step 1 to step 7. Nobody will prompt you again, so finish
in this turn. The only wait is a `QUEUED` / `QUEUE-FULL` PR, watched as in
step 6; every check ran locally.

## Proof

Proof is evidence you observed yourself in this session: command output, a
reproduction, a screenshot. Use the most direct proof the change allows:

- Reproduce the original failure, apply the fix, then watch the same
  reproduction pass.
- Run the repo's local gate (lint, typecheck, build, tests).
- Add one focused test that fails without the fix, when the behavior has none
  and the repo has a test setup.
- For UI and runtime behavior, run the app and look at the change. In T3
  Code: `preview_open` (with `target` for a dev-server port), `preview_act`,
  `preview_snapshot` and `preview_recording_*` for web; `device_open` and
  `device_screenshot` for iOS and Android. Close tabs you opened. Green mocked
  tests do not prove that the user experience works. Attach screenshots to the
  PR when they help and you have a way to upload them.

When you cannot find a way to prove a change, you do not have full confidence.
Ask the user.

## Merge gate

Full confidence means all of these are true on the latest commit:

- Your proof covers every change in the diff.
- The local gate passed on this commit: lint, typecheck, build, reached tests
  and specs.
- The CodeRabbit CLI run (where present) and the cross-family review are
  clean: each finding is fixed or dismissed with a written reason.
- No human review still requests changes.
- The branch is up to date with the default branch, and GitHub reports it as
  mergeable.

Land with `land-pr <n> --sha <gated sha>` per `pr-workflow` section 4. Use
no `--auto`, no GitHub merge queue, no `--admin` or other bypasses. Done
means GitHub reports the PR as merged.

## Asking the user

A question in a normal message goes unseen, and the thread looks done. To ask
the user something (other than a secret: for a key or token, call
`request_secret` in T3 Code), use the harness's question tool so the thread shows that
it is waiting: `AskUserQuestion` in Claude Code, `request_user_input` in Codex,
or the question tool your harness has. Put all the context in the question:
the PR link, what blocks you, and the options with your recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant above: deleting data, touching production,
  changing things outside the repo, closing a PR, or force-pushing any other
  branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and list those decisions
in the report.

If no question tool is available, or the tool returns no answer, take the safe
path: leave the PR open and unmerged, and start your final message with the
question.
