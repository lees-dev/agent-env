# Ready to merge before it opens

A PR is opened only when it would pass every gate as it stands. Review rounds after opening cost a CI run per push, a bot review per push, and hours of wall time. Each finding a review bot raises on an open PR is a gap in this process, so fix the process, not only the PR.

## 1. Collect the repo's review rules (once per repo, before the first brief)

The review bot's rules are written down. Read them before anything is built:

```sh
ls .coderabbit.yaml .coderabbit.yml .github/coderabbit.yaml 2>/dev/null   # CodeRabbit
grep -rlnE "coderabbit|review-gate|reviewdog|sonar|codeql" .github scripts 2>/dev/null
```

- **The review bot's config.** For CodeRabbit, this is `reviews.path_instructions` (per-path rules such as "tests drive the public boundary" or "bound every timeout") and `reviews.pre_merge_checks`, especially the `error`-mode checks that fail the gate.
- **The gate script.** It shows the exact command the gate runs and which severities block. For example, a `review-gate` that runs `coderabbit review --agent --deep --gate major --committed --base-commit <merge-base>`.
- **The repo's own checklist.** This is the pre-push checklist in AGENTS.md / CONTRIBUTING / the PR template, plus its size, research and privacy rules.

## 2. Brief the builder with those rules

Every agent or subagent brief that writes code for a PR includes, verbatim:

- the bot's path instructions that match the paths the change will touch;
- the repo's pre-push checklist;
- the gate's blocking severity ("no Critical or Major finding may remain").

Builders who see the rules write to them. Builders who don't produce the findings the bot then raises.

## 3. Run the gate locally, on the committed head

After the repo's own lint, typecheck and tests pass, commit, then loop at most 3 rounds:

1. **Review bot, gate command.** Run the bot's CLI with the gate's exact flags, against the committed diff from the merge-base with the base branch, using the base branch's config. For CodeRabbit:

   ```sh
   coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"
   ```

   Exit 0 means no blocking finding, and exit 2 means a Critical or Major finding remains. **The review is non-deterministic.** The same CLI version, flags and base can pass locally and fail in CI. So require **two independent clean runs on the final head**, run in parallel; a single clean run is not enough. If the CLI can't run on this OS (the CodeRabbit CLI ships for Linux and macOS only), run it on a Linux host the repo names. Use the review command documented by that repository.
2. **Cross-family review.** Have a different model family review the same committed diff: Codex for work Claude built, Claude for work Codex built (for example the repo's `codex-review.sh`). Fix every P0 and P1.
3. **Fix every real Critical or Major finding**, and every actionable Minor too when the bot requests changes on any actionable comment (CodeRabbit `auto_approvals`: it then blocks the merge until it approves),, then rerun both reviews. If a finding is wrong, write down the evidence (file:line, a test, a docs URL) now. Put it in the PR body so the bot's reviewer sees it.

Also verify before opening:

- the pre-merge checks the gate enforces: title, body size (CodeRabbit truncates long bodies and then marks error-mode checks such as No Client Content inconclusive, so keep it at or under 2.5 KB), a Research section if the repo requires one, and no private or client content;
- the diff size limit and any sensitive-path rules;
- that the branch is based on the current base branch.

## 4. Open once

Open the PR with one push, and only after the local gate is clean. Record what ran in the PR's Validation section: the local review's exit code and counts, the cross-family verdict, and the test counts.

## 4b. Rebases

Gate on the current base: rebase before the local gate whenever the base branch's CI or scripts changed. CI checks out the PR head, so a stale base can be missing files that the base's workflows call.

After a rebase-only push, review bots that diff incrementally (CodeRabbit) report "No files to review" and post no review of the new head. Gates and approvers that require a bot review of the exact head then stall. Comment `@coderabbitai full review` right after such a push.

## 5. When the bot still finds something

A Critical or Major finding on an open PR means a rule was missing from the brief or the local gate didn't match the real gate.

- Fix the PR in one batched push.
- Then encode the lesson: add the rule to the repo's checklist (or its "Learned mistakes" list), or fix the local gate command so the next PR catches it before opening.
