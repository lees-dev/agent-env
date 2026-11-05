## Engineering standards for every repo (owner, 2026-11-04)

These apply in every repository and to every agent harness: Claude Code, Codex, Grok, Muse Code and any other. A repo's own AGENTS.md, CLAUDE.md, PR template and gate docs win where they are stricter or differ. The full procedure is in the `pr-workflow` skill (`~/.agents/skills/pr-workflow/SKILL.md`, also `~/.claude/skills/pr-workflow`). Load it before briefing anyone to build a PR, and before opening, pushing to, updating, re-running CI on, merging or cleaning up any pull request.

- **A PR opens only when it is already ready to merge** (pr-workflow section 2). Review rounds after opening are not the process.
  - Every builder brief, whether for you, a subagent or a workflow agent, carries the repo's review rules verbatim: the review bot's config (CodeRabbit: `.coderabbit.yaml` `path_instructions` and `pre_merge_checks`), the gate script's blocking severity, and the repo's pre-push checklist.
  - Before opening, run the repo's lint, typecheck and tests. Then run the review bot's CLI with the gate's own flags on the committed head. For CodeRabbit: `coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"`; it ships for Linux and macOS, so use a Linux host from Windows. The review is non-deterministic, so it must come back clean on two independent runs of the final head. Then run a cross-family model review (Codex for Claude-built work, Claude for Codex-built work).
  - Fix every Critical, Major, P0 and P1, recommit, and rerun. If the repo's bot requests changes on any actionable comment (CodeRabbit `auto_approvals`), fix its actionable Minor findings too, because they block the merge until the bot approves, for at most 3 rounds. Check the pre-merge checks (title, body at or under 2.5 KB, since a truncated body makes CodeRabbit's error-mode checks inconclusive, a Research section if the repo requires one, no private or client content), the size limit, and the base branch.
  - Open with one push, and record the local review results in the PR. A blocking finding after opening is a process gap: fix the PR, then add the missing rule to the repo's checklist.
- **Clean up once a PR merges or closes** (pr-workflow section 7). Remove everything the work created, wherever it ran:
  - local and remote worktrees and their branches;
  - server checkouts, proof and review dirs, and helper refs (`prove/*`, `cr/*`);
  - test databases, containers and volumes;
  - scratch folders and temp files;
  - watchers, monitors, background jobs and PR watches.

  First confirm the PR state, and that nothing is dirty or unpushed. Never remove anything an open PR, a stacked branch or a running job uses, or any production data. Report what was removed, counts only.
- **Keep CI cheap.** Every push is a CI run: batch fixes into one push, rebase only when needed, rerun only failed jobs, and only after naming the cause.
