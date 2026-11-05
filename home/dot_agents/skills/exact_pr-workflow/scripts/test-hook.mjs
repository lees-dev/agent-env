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
  ["Bash", "gh run rerun 123 --failed", true],
  ["Bash", "gh -R example-owner/example-repo pr merge 645 --auto", true],
  ["Bash", "gh --repo=o/r pr create --fill", true],
  ["PowerShell", "& git.exe push origin HEAD", true],
  ["Bash", 'git -C "C:/Users/me/My Repo" push', true],
  ["Bash", "gh pr update-branch 42", true],
  ["Bash", "gh workflow run ci.yml --ref main", true],
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

const bad = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
const badOk = bad.status === 0 && bad.stdout === "";
if (!badOk) failed++;
console.log(`${badOk ? "PASS" : "FAIL"}  exit=${bad.status}  malformed stdin stays silent`);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
