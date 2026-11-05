#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash / PowerShell tools). Non-blocking: it never
// denies a call and always exits 0. When the command pushes to a branch or
// opens, readies, merges or re-runs a pull request's CI, it adds a short
// reminder to follow the pr-workflow skill as additionalContext.
// Docs: https://code.claude.com/docs/en/hooks (PreToolUse, additionalContext)

// gh (or gh.exe, or a gh-<name> wrapper such as gh-app), then any global repo flags, then the
// subcommand: `gh -R o/r pr merge 1`, `~/bin/gh-app pr create`.
const GH = String.raw`\bgh(?:-[\w-]+)?(?:\.exe)?["']?(?:\s+(?:-R|--repo)(?:\s+|=)\S+)*\s+`;

const RULES = [
  {
    // git push, also `git -C dir push`, `git -c k=v push`; not `git stash push`
    re: /(?:^|[\s;&|(`"'\/])git(?:\.exe)?["']?(?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w.-]+(?:=\S+)?))*\s+push(?:\s|$)/,
    say: "This command pushes to a branch; a push to a PR head re-runs that repo's CI. pr-workflow: local lint, typecheck and tests pass, all pending fixes are in this one push, and no repeated rebase or force-push.",
  },
  {
    re: new RegExp(GH + String.raw`pr\s+create\b`),
    say: "This command opens a pull request. pr-workflow section 2: open it only when it is already ready to merge. The review bot's CLI with the gate's own flags (CodeRabbit: coderabbit review --agent --deep --gate major --committed --base-commit <merge-base>) and a cross-family review must be clean on this committed head, and the repo's pre-merge checks (template, body size, Research, privacy, size limit) must pass. If they have not run clean, run them now instead of opening.",
  },
  {
    // push wrappers such as git-app-push (they run git push themselves)
    re: /(?:^|[\s;&|(`"'\/])git-[\w-]*push(?:\.\w+)?["']?(?:\s|$)/,
    say: "This command pushes to a branch; a push to a PR head re-runs that repo's CI. pr-workflow: local lint, typecheck and tests pass, the local review gate is clean on this commit, all pending fixes are in this one push, and no repeated rebase or force-push.",
  },
  {
    re: new RegExp(GH + String.raw`pr\s+ready\b`),
    say: "This command marks a pull request ready, which can start its CI. pr-workflow: local checks pass and the branch holds every fix first.",
  },
  {
    re: new RegExp(GH + String.raw`pr\s+merge\b`),
    say: "This command merges a pull request. pr-workflow: follow the repo's merge rules; prefer its merge queue or auto-merge, and leave gates and required checks in place.",
  },
  {
    re: new RegExp(GH + String.raw`run\s+rerun\b`),
    say: "This command re-runs CI. pr-workflow: read the failing log first (gh run view <id> --log-failed); for a flake rerun only failed jobs (--failed) once, with the reason stated.",
  },
  {
    re: new RegExp(GH + String.raw`(?:pr\s+update-branch|workflow\s+run)\b`),
    say: "This command updates a pull request's branch or starts a workflow, which starts CI runs. pr-workflow: update from the base only for a conflict or a repo rule, once; start a workflow only when no event-driven path exists.",
  },
  {
    re: new RegExp(GH + String.raw`api\b.*\/pulls\/\d+\/(?:merge|update-branch)\b`),
    say: "This API call merges or updates a pull request. pr-workflow: follow the repo's merge rules and prefer its merge queue or auto-merge; update from the base only when needed.",
  },
  {
    re: new RegExp(GH + String.raw`(?:pr|issue)\s+(?:comment|review)\b.*@[\w-]*(?:coderabbit|codex|copilot|claude|gemini|sourcery)`, "i"),
    say: "This command asks a review bot for a review. pr-workflow: read the bot's latest review first, send one command per real need, and let it finish.",
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
