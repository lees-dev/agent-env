#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash / PowerShell tools). Non-blocking: it never
// denies a call and always exits 0. When the command pushes to a branch or
// opens, readies or merges a pull request, it adds a short
// reminder to follow the pr-workflow skill as additionalContext.
// Docs: https://code.claude.com/docs/en/hooks (PreToolUse, additionalContext)

// gh (or gh.exe, or a gh-<name> wrapper such as gh-app), then any global repo flags, then the
// subcommand: `gh -R o/r pr merge 1`, `~/bin/gh-app pr create`.
const GH = String.raw`\bgh(?:-[\w-]+)?(?:\.exe)?["']?(?:\s+(?:-R|--repo)(?:\s+|=)\S+)*\s+`;

// Shared texts; the rules they summarize live in pr-workflow section 4.
const PUSH =
  "This command pushes to a branch. pr-workflow section 4, editing a queued PR: never push to a PR labelled landing (wait for its merge or bounce). If the PR already carries queue-hold (the owner, full-stop or someone else set it), leave it, push nothing that lands, and report it. For a PR labelled queued, queue-next, queue-waiting or queue-blocked: add your own queue-hold first with land-pr hold <n> --holder <id> (it writes the Hold-By: line; same id on every call), confirm there is no landing (if you find landing while holding your own hold, remove your hold and wait), push, run the affected gate and the review of the new range, then land-pr <n> --sha <new gated sha> --release-hold --holder <id> (refreshes the gated sha and removes only your own hold). If you are pushing fixes, rerun the local gate first (lint, typecheck, build, reached tests and specs, all clean on this commit).";
const LANDER_CHECK =
  "Before land-pr, check list_scheduled_tasks for the repo's land-queue schedule and that ~/.agents/bin/land-pr.mjs exists; if either is missing, do not run land-pr (it could queue with nobody to drain it): use the fallback.";
const MERGE_BY_HAND =
  "pr-workflow section 4: land with land-pr <n> --sha <gated sha> instead of merging by hand. " + LANDER_CHECK + " Merge by hand only under that fallback (land-pr is missing or the repo has no lander schedule yet), one at a time, with the repo's merge script or identity, and only when the repo is not paused (AGENT_LANDING_PAUSED is not 1), every Depends-on: #n is merged, the PR has no queue labels (never one labelled queued, landing, queue-blocked, queue-hold, queue-next or queue-waiting), and <sha> is the commit the gate and review passed on (Gate: pass @ <sha> in the PR body); refetch and recheck git merge-base --is-ancestor origin/<base> <sha> immediately before merging (--match-head-commit pins the head, not the base); no --auto, no --admin; if the base moved, rebase and rerun the gate first; otherwise stop and report; report \"fallback used\".";

const RULES = [
  {
    // git push, also `git -C dir push`, `git -c k=v push`; not `git stash push`
    re: /(?:^|[\s;&|(`"'\/])git(?:\.exe)?["']?(?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w.-]+(?:=\S+)?))*\s+push(?:\s|$)/,
    say: PUSH,
  },
  {
    re: new RegExp(GH + String.raw`pr\s+create\b`),
    say: "This command opens a pull request. pr-workflow: run the repo's local gate and reviews first (lint, typecheck, build, reached tests and specs; CodeRabbit CLI once where the repo has .coderabbit.yaml; the cross-family review subagent-routing sets, one focused reviewer by default, the four-model panel only for complex or sensitive Opus-built work; no Critical, Major, P0 or P1 left), all clean on this committed head. Open ready with the local results and a Linear-Priority: line in the body, then land it with land-pr <n> --sha <gated sha> and follow pr-workflow section 4 for its outcome (MERGED, QUEUED, QUEUE-FULL, REFUSED). " + LANDER_CHECK + " In T3, call link_pull_request with the full URL as your next call. If they have not run clean, run them now instead of opening.",
  },
  {
    // push wrappers such as git-app-push (they run git push themselves)
    re: /(?:^|[\s;&|(`"'\/])git-[\w-]*push(?:\.\w+)?["']?(?:\s|$)/,
    say: PUSH,
  },
  {
    re: new RegExp(GH + String.raw`pr\s+ready\b`),
    say: "This command marks a pull request ready. pr-workflow: PRs open ready. The local gate and reviews must be clean on this head; land it with land-pr <n> --sha <gated sha> next.",
  },
  {
    re: new RegExp(GH + String.raw`pr\s+merge\b`),
    say: "This command merges a pull request. " + MERGE_BY_HAND,
  },
  {
    // `gh pr checks ... --watch` with the flag enabled, in the same shell command (not after ; & | or a newline)
    re: new RegExp(GH + String.raw`pr\s+checks\b[^;&|\n]*?\s--watch(?:=true)?(?=\s|[;&|]|$)`),
    say: "This command polls PR checks. In T3, do not poll: if something outside your control still blocks the merge, call watch_pull_request, end the turn, and call unwatch_pull_request before handback. pr-workflow: checks run locally before the PR opens, so there is normally nothing to wait on.",
  },
  {
    re: new RegExp(GH + String.raw`run\s+watch\b`),
    say: "This command follows a GitHub Actions run (release or deploy). In T3, run it as a background command and wait with t3_background_wait (Claude Code), not in the foreground; use watch_pull_request only for PR checks.",
  },
  {
    re: new RegExp(GH + String.raw`pr\s+update-branch\b`),
    say: "This command updates a pull request's branch from its base. pr-workflow: prefer a local rebase, then rerun the affected gate checks and reviews before merging.",
  },
  {
    re: new RegExp(GH + String.raw`api\b.*\/pulls\/\d+\/(?:merge|update-branch)\b`),
    say: "This API call merges or updates a pull request. " + MERGE_BY_HAND,
  },
  {
    re: new RegExp(GH + String.raw`(?:pr|issue)\s+(?:comment|review)\b.*@[\w-]*(?:coderabbit|codex|copilot|claude|gemini|sourcery)`, "i"),
    say: "This command asks a review bot for a review. pr-workflow: reviews run locally before the PR opens (CodeRabbit CLI where present, plus a cross-family review). An open PR is landed with land-pr; send one command per real need.",
  },
];

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw);
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return;
    const hits = RULES.filter((rule) => rule.re.test(command)).map((rule) => rule.say);
    if (hits.length === 0) return;
    const text =
      "The user's global instructions ask for the pr-workflow skill (/pr-workflow) on pull-request work; load it if it is not loaded in this session. " +
      hits.join(" ");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
      }),
    );
  } catch {
    // Malformed input: stay silent so the tool call is never affected.
  }
});
