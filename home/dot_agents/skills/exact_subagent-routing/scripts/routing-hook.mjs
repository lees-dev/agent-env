// PreToolUse hook for Claude Code's Agent, Task and Workflow tools.
// Inside T3 Code (T3CODE_THREAD_ID is set, T3_FIRST_OFF is not) it denies the call: every agent goes through T3's
// delegate_task (see ~/.agents/docs/agents/t3-first.md). Outside T3 it never blocks; it only
// injects the subagent-routing reminder so every spawn carries an explicit, routed model.
// Installed by ~/bin/sync-agent-standards with the skill.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw || "{}"); } catch { return; /* malformed stdin: stay silent, never block */ }
  const tool = String(input.tool_name || "");
  const args = input.tool_input || {};
  const routing =
    "Routing: build -> Opus 5.5 (high; xhigh for hard bugs); review -> one focused cross-family reviewer by default, routine fixes included whatever their size (GPT Sol high for Opus-built work, Opus for GPT-built work, GPT Sol otherwise), plus a second family for security, auth, data loss, migrations or concurrency; Opus-built complex new behavior or a sensitive path -> panel of GPT Sol high, Muse Wonder Full xhigh, Grok 4.7 high, Sonnet 5.5 high; planning -> the main thread writes the plan; planning council of Opus 5.5, GPT Sol, Muse Wonder Full and Grok 4.7 (all high) only for a genuine unresolved design trade-off or when the user asks for one; copy -> Muse Wonder Full; bulk edits -> GPT Luna or Muse Spark; search, reading, research -> Claude Sonnet (Haiku for lookups). No Gemini.";

  // T3_FIRST_OFF=1 lifts the block for a session where the user explicitly wants Agent/Workflow.
  if (process.env.T3CODE_THREAD_ID && process.env.T3_FIRST_OFF !== "1") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `t3-first: inside T3 Code, ${tool || "this tool"} is not used to start agents. Use delegate_task instead (load it with ToolSearch if deferred): target.providerInstanceId, target.model, effort in target.options, and a role, routed by the subagent-routing skill. ${routing}`,
      },
    }));
    return;
  }

  const lines = [
    "subagent-routing: route this spawn by task type (load the subagent-routing skill if it is not loaded).",
    routing,
    "This tool starts Claude models only. For a GPT, Muse or Grok target outside T3, use that harness's CLI.",
  ];
  if (/(^|_)Agent$/.test(tool) && !args.model && !args.subagent_type) {
    lines.push("This Agent call names no model, so it inherits yours. Set model explicitly.");
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: lines.join("\n") },
  }));
});
