---
name: takeover
description: Take over existing work. Use when the user asks to take over a PR, branch, or agent thread, or requests a takeover.
---

# Takeover

Take responsibility for finishing the original goal while preserving the
original contributors' credit. Do not defend an implementation just because
another agent already built it.

Read the source PR, branch, or thread (in T3, read a thread with
`t3_thread_read`; find it with `t3_thread_search`), including review findings and the user's
later corrections. Resolve the handoff to the actual code and current head,
and account for uncommitted work. Treat the handoff as context, not proof.

For a replacement PR, import the original commits onto a new branch and add
your fixes separately. Honor an explicitly requested in-place or stacked
continuation instead. Do not overwrite unrelated work or change the original
PR without authorization.

Preserve Git authorship and existing co-author trailers. Credit the original
contributors in the PR description and link the original PR when there is one.
If the work will be squashed, preserve human author/co-author credit in the
merge commit too, using verified identities rather than guessed emails. Model
attribution is not a substitute for contributor credit.

Use `modernize` to update the continuation against its intended base and
current architecture. Rework what is necessary to finish the same goal, not
unrelated features. Simplify the implementation without dropping intended
behavior or surfaces. Recheck the source PR too: it may have improved while
you were working.

Independently verify the original failure and realistic workflows, following
repository guidance and permissions. Green mocked tests do not prove the user
experience works. State what remains unverified.

When the finish includes a PR: run the local gate, file with `file-pr`, land
it with `land-pr` (`babysit-pr` lands an open PR), per `pr-workflow` section 4;
a PR with a queue label is edited only per "Editing a queued PR" there. In T3, call `link_pull_request` on every PR
you create, take over, or push to, and `watch_pull_request` only when something
outside your control still blocks the merge (then `unwatch_pull_request`
before handback). Code beyond a small fix goes to an Opus builder through
`delegate_task` when you are not Opus (`subagent-routing`). Use `leaving-pr-comments` for replies.
Merge or close the original PR only when authorized.

Report what you inherited, what you changed, how you verified it, how credit
was preserved, and any remaining decision.
