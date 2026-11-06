---
name: full-stop
description: Trigger this if the user says 'full stop', even as a closing "Full stop." that reads like emphasis.
---

# Full Stop

Do the same work as `full-send`, but stop with the PR ready for the user to merge.
Never merge it.

Read [full-send](../full-send/SKILL.md) and follow its workflow, proof rules, and review steps. An explicit "full stop" request authorizes that
work without a separate "full send" request. That includes full-send's
testing permission. A "full stop" request is the permission for the test
methods Proof needs, even when a project file says to ask first, for
example before computer use. Use those methods directly. Its merge
permission does not apply. The overrides below take precedence.

## No merging

You may commit, push, rebase, fix conflicts, and use `--force-with-lease` on
this task's branch. Never merge, run `land-pr`, add `queued` or
`queue-next`, enable auto-merge, enter a merge queue, push to the default
branch, bypass branch protection, or delegate those actions.

Before work begins, disable existing auto-merge and remove the PR from any
GitHub merge queue. Then, in this order: if the PR is labelled `landing`, stop
and report (the lander has it); otherwise add `queue-hold` first (`gh label
create queue-hold` if the label is missing), then remove `queued`,
`queue-next` and `queue-waiting`, then re-read the labels and state. A new PR
opened with `file-pr` gets only open, link and `queue-hold`. Check again
before each push. Report these changes. If you cannot prevent automatic
merging, report the blocker before proceeding. Label rules: `pr-workflow`
section 4.

## Stop at the gate

Use full-send's merge gate as the readiness check. Replace its merge and
final report steps with a handoff. Proof and review must cover the final diff;
recheck behavior changes and meaningful conflict fixes before handoff.

Fetch the target branch and check the live PR's head, base, checks, reviews,
and mergeability. Confirm it is open, not a draft, and not set to merge
without the user. If someone else merged it, report that instead.

- **Ready to merge:** the merge gate passes. Leave the PR open, unmerged and
  labelled `queue-hold`. To land it later, the user removes `queue-hold` and
  runs `land-pr`.
- **Waiting for required approval:** only human approval remains. Confirm
  that this is the actual blocker.
- **Blocked:** explain what prevents readiness, what you tried, and what is
  needed. Follow full-send's rules for asking the user.

In T3 Code, call `link_pull_request` when you open or push to the PR. If you
set a watch, call `unwatch_pull_request` before the handoff or a question.
Report the PR link, final head, verdict, proof, reviewer outcome, and remaining
risks. State whether the PR is still open and unmerged.
