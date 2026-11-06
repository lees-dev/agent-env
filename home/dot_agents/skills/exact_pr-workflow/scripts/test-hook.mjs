// Pipes sample PreToolUse payloads into pr-workflow-hook.mjs and checks each result.
// Run: node test-hook.mjs   (exits 1 on any failure)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "pr-workflow-hook.mjs");

const payload = (tool, command) =>
  JSON.stringify({
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command, description: "test" },
    tool_use_id: "toolu_test",
  });

const cases = [
  ["Bash", "git push -u origin agent/feature", true],
  ["Bash", "npm test && git push", true],
  ["Bash", "git -C /tmp/repo push origin HEAD", true],
  ["PowerShell", "git push --force-with-lease", true],
  ["Bash", "gh pr create --draft --fill", true],
  ["Bash", "gh pr ready 42", true],
  ["Bash", "gh pr merge 42 --auto --squash", true],
  ["Bash", "gh run rerun 123 --failed", false],
  ["Bash", "gh -R example-org/example-repo pr merge 645 --auto", true],
  ["Bash", "gh --repo=o/r pr create --fill", true],
  ["PowerShell", "& git.exe push origin HEAD", true],
  ["Bash", 'git -C "C:/Users/me/My Repo" push', true],
  ["Bash", "gh pr update-branch 42", true],
  ["Bash", "gh workflow run ci.yml --ref main", false],
  ["Bash", "gh pr checks 42 --watch", true],
  ["Bash", "gh run watch 123", true],
  ["Bash", "gh pr checks 42", false],
  ["Bash", "gh pr checks 42 --watch=false", false],
  ["Bash", "gh pr checks 42; echo --watch", false],
  ["Bash", "gh pr checks 42 | grep --watch", false],
  ["Bash", "gh pr checks 42 --watch=true --interval 10", true],
  ["Bash", "gh pr checks 42 --watch; echo done", true],
  ["Bash", "gh pr checks 42 --watch=true; echo done", true],
  ["Bash", "gh pr checks 42 --watch&& echo done", true],
  ["Bash", "gh api -X PUT repos/o/r/pulls/42/merge", true],
  ["Bash", "gh pr comment 42 --body '@coderabbitai full review'", true],
  ["Bash", "~/bin/gh-app pr create -R o/r --base main --head x --body-file b.md", true],
  ["Bash", "~/bin/git-app-push https://github.com/o/r.git HEAD:refs/heads/x", true],
  ["Bash", "~/bin/gh-app pr view 42", false],
  ["Bash", "gh pr comment 42 --body 'thanks'", false],
  ["Bash", "gh api repos/o/r/pulls/42", false],
  ["Bash", "git stash push -m wip", false],
  ["Bash", "git status", false],
  ["Bash", "gh pr view 42", false],
  ["Bash", "echo pushing", false],
  ["Bash", "node ~/.agents/bin/land-pr.mjs 42 --sha abc123", false],
  ["PowerShell", "node \"$HOME/.agents/bin/land-queue.mjs\" status --all", false],
];

let failed = 0;
for (const [tool, command, expectContext] of cases) {
  const run = spawnSync(process.execPath, [hook], { input: payload(tool, command), encoding: "utf8" });
  let context = null;
  if (run.stdout.trim()) context = JSON.parse(run.stdout).hookSpecificOutput?.additionalContext ?? null;
  const ok = run.status === 0 && Boolean(context) === expectContext;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  exit=${run.status}  context=${context ? "yes" : "no "}  ${tool}: ${command}`);
}

// The local-gate wording is the contract: check the key phrases land.
const phrases = [
  ["gh pr create --fill", ["local gate and reviews first", "land-pr <n> --sha <gated sha>", "Linear-Priority:", "link_pull_request", "list_scheduled_tasks", "land-queue schedule", "~/.agents/bin/land-pr.mjs", "use the fallback"]],
  ["gh pr ready 42", ["land-pr <n> --sha <gated sha>"]],
  ["gh pr checks 42 --watch", ["watch_pull_request", "unwatch_pull_request"]],
  ["gh run watch 123", ["t3_background_wait", "only for PR checks"]],
  ["gh pr merge 42 --squash", ["land-pr <n> --sha <gated sha>", "fallback", "list_scheduled_tasks", "~/.agents/bin/land-pr.mjs", "AGENT_LANDING_PAUSED", "Depends-on", "Gate: pass @ <sha>", "no queue labels", "queue-hold", "queue-next", "one at a time", "--is-ancestor origin/<base> <sha>", "pins the head, not the base", "no --auto", "rebase and rerun the gate", "stop and report", "fallback used"]],
  ["gh api -X PUT repos/o/r/pulls/42/merge", ["land-pr <n> --sha <gated sha>", "fallback", "AGENT_LANDING_PAUSED", "Depends-on", "Gate: pass @ <sha>", "no queue labels", "--is-ancestor origin/<base> <sha>", "fallback used"]],
  ["git push origin HEAD", ["never push to a PR labelled landing", "already carries queue-hold", "push nothing that lands", "queue-next", "add your own queue-hold first", "Hold-By:", "remove your hold and wait", "affected gate", "review of the new range", "land-pr <n> --sha <new gated sha> --release-hold --holder <id>", "land-pr hold <n> --holder <id>", "removes only your own hold", "rerun the local gate first"]],
  ["~/bin/git-app-push https://github.com/o/r.git HEAD:refs/heads/x", ["never push to a PR labelled landing", "add your own queue-hold first", "--release-hold"]],
  ["gh pr create --fill --body x", ["pr-workflow section 4", "QUEUE-FULL", "REFUSED"]],
];
for (const [command, needles] of phrases) {
  const run = spawnSync(process.execPath, [hook], { input: payload("Bash", command), encoding: "utf8" });
  const context = run.stdout.trim() ? (JSON.parse(run.stdout).hookSpecificOutput?.additionalContext ?? "") : "";
  const missing = needles.filter((n) => !context.includes(n));
  const hasOld = /re-runs that repo's CI|merge queue or auto-merge|two independent|merge at once|merges at once|should already be merged or queued|npm run merge/.test(context);
  const ok = run.status === 0 && missing.length === 0 && !hasOld;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  wording  ${command}${missing.length ? `  missing: ${missing.join(", ")}` : ""}${hasOld ? "  old CI wording present" : ""}`);
}

const bad = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
const badOk = bad.status === 0 && bad.stdout === "";
if (!badOk) failed++;
console.log(`${badOk ? "PASS" : "FAIL"}  exit=${bad.status}  malformed stdin stays silent`);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
