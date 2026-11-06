---
name: file-pr
description: File a concise pull request and land it with land-pr. Use when the user asks to file, open, or create a PR.
---

# File PR

Before filing, check whether a PR for this branch already exists. Review the
diff locally against the base branch (usually `origin/main`) to make sure its
contents match the goal.

File only a PR that is ready to merge. Run the repo's local gate first (see
`pr-workflow`): lint, typecheck, build, reached tests and specs, CodeRabbit
CLI once where present, the cross-family review `subagent-routing` sets (the
four-model panel for larger Opus-built changes). Fix every Critical, Major,
P0 and P1. If the gate has not run clean, run it now instead of filing.
Record the results in the body, plus a `Linear-Priority: <0-4>` line (the
ticket's Linear priority) and `Depends-on: #n` for any PR this one needs first.

PR titles usually become commit messages, so follow the repository's title
conventions. Look at recently merged PRs and Git history for examples. Prefer a
concise, human-readable title that explains why the change matters:

BAD

> ❌ perf(server): negotiate permessage-deflate on the websocket

GOOD

> ✅ perf(server): cut websocket frame size by 70%+ with gzipping

Open the description with a simple explanation of the problem based on the
user's original prompt, then briefly explain the solution. Do not lead with an
implementation inventory:

BAD

> ❌ Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD

> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

End the description with the public model name and harness that made the
changes, for example `Created with <model> in <harness>.` Include subagent
models that wrote part of the change. Use the model name the harness reports.
If model identity is unavailable, name the harness without guessing a model.

Before submission, check title, description, quotes, attachments for secrets.

Open ready, not as a draft. In T3 Code, call `link_pull_request` with the full
URL as your next call (`link_pull_requests` for a stack, every layer). Then
land it with `land-pr <n> --sha <gated sha>` and follow `pr-workflow` section 4
for its outcome (`MERGED`, `QUEUED`, `QUEUE-FULL`, `REFUSED`), kicking the
lander, and the fallback when `land-pr` or the lander is missing. Report the
outcome. No `--auto`, GitHub merge queue, or `--admin`. Under `full-stop`,
only open, link and add `queue-hold`; never run `land-pr`. If `gh pr create` hits the GraphQL limit,
open via REST (`gh api repos/<o>/<r>/pulls -f title=... -f head=... -f base=... -F body=@<file>`).

Do not post a follow-up PR comment unless it serves the user's request. When a
comment is needed, use the `leaving-pr-comments` skill.
