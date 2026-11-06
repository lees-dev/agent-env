# Ready to merge before it opens

A PR opens only when it is ready to merge as it stands. Every check runs locally on the committed head. Open the PR, then land it with `land-pr`.

## 1. Collect the repo's rules (once per repo, before the first brief)

- **The local gate.** Exact commands from `AGENTS.md` / `CLAUDE.md`, `package.json` scripts, `Makefile`, or `scripts/`: lint, typecheck, build, tests, browser/E2E specs. Prefer the repo's single gate or affected-tests command when it has one; otherwise use its full test command.
- **The review rules.** `.coderabbit.yaml` path instructions where present, the repo's pre-push checklist, size limit, and sensitive paths.
- **The merge and release steps.** Merge method and identity from `.agents/repo.json`, `docs/agents/repo.md` or recent merged PRs. Any release or approval step that guards production. These are facts the repo supplies; the landing process itself is global (`land-pr`).

## 2. Brief the builder with those rules

Every `delegate_task` brief (or other agent brief) that writes code for a PR includes, verbatim:

- the path instructions that match the paths the change will touch;
- the repo's pre-push checklist;
- the bar: "no Critical, Major, P0, or P1 finding may remain."

## 3. Run the gate locally, on the committed head

Commit, then run in order. Fix, recommit, and rerun until clean.

1. **Local gate.** Lint, typecheck, build, and the tests the change reaches. Run only the browser/E2E specs the change adds or edits.
2. **CodeRabbit CLI**, once, when the repo has `.coderabbit.yaml`:

   ```sh
   coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"
   ```

   Exit 0 means no blocking finding. The CLI runs on Linux/macOS only. From Windows, run it in WSL from a clone whose `origin` is the GitHub URL.
3. **Cross-family review**, as `subagent-routing` sets it, started with `delegate_task` in T3: one focused cross-family reviewer by default (GPT Sol for Claude-built work, Opus for GPT-built work), whatever the change's line or file count, plus a second family when it touches security, auth, data loss, migrations, or concurrency; the four-model review panel (GPT Sol, Muse Wonder Full, Grok 4.7, Sonnet) only for complex new behavior or a sensitive path in Opus-built work.
4. **Fix** every Critical, Major, P0, and P1. Rerun the checks and reviews that found them. If a finding is wrong, write down the evidence (file:line, a test, a docs URL) and put it in the PR body.

Also verify: title follows the repo's convention; no private or client content; the diff size limit; the branch is based on the current base branch; the body has a `Linear-Priority: <0-4>` line and `Depends-on: #n` for any PR this one needs first.

Done when the gate, the CodeRabbit run (where present), and the cross-family review are clean on the commit you will push.

## 4. Open, then land

1. Push once. Open the PR ready (not draft). Record what ran in the body: each check, each review, and the result. In T3, call `link_pull_request` with the full URL next.
2. Land it, pinned to the checked commit: `land-pr <n> --sha <gated sha>`. It prints `MERGED <sha>`, `QUEUED <pos>`, `QUEUE-FULL <pos>` or `REFUSED <reason>`. Use no `--auto`, no GitHub merge queue, no `--admin`.
3. Everything after that (the outcomes, kicking the lander, labels, editing a queued PR, bounces, when the work is done, and the fallback when `land-pr` or the lander is missing) is in `SKILL.md` section 4.

## 5. When a check fails

1. Read the failing output. Name the cause.
2. Fix locally. Rerun that check until it passes.
3. Rerun the rest of the gate. Then open and land.

A blocking finding that surfaces only after opening means the brief or the gate missed a rule. Fix the PR, then add that rule to the repo's checklist so the next PR catches it locally.
