// PreToolUse hook for Claude Code's Agent and Workflow tools.
// Injects the subagent-routing reminder so every spawn carries an explicit, routed model.
// Never blocks: it only adds context. Installed by ~/bin/sync-agent-standards with the skill.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { /* run with the generic reminder */ }
  const tool = String(input.tool_name || "");
  const args = input.tool_input || {};
  const lines = [
    "subagent-routing: route this spawn by task type (load the subagent-routing skill if it is not loaded).",
    "Build a scoped change -> GPT Sol; review -> a family other than the builder's; architecture, copy -> Muse Wonder Full; bulk edits -> GPT Luna or Muse Spark; search, reading, research -> Claude Sonnet or Haiku.",
    "This tool starts Claude models only. For a GPT, Muse or Grok target, use delegate_task (target.providerInstanceId, target.model, target.options effort) instead.",
  ];
  if (/(^|_)Agent$/.test(tool) && !args.model && !args.subagent_type) {
    lines.push("This Agent call names no model, so it inherits yours. Set model explicitly.");
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: lines.join("\n") },
  }));
});
