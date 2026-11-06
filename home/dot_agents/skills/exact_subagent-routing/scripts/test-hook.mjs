// Tests for routing-hook.mjs. Run: node test-hook.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "routing-hook.mjs");
const base = { ...process.env };
delete base.T3CODE_THREAD_ID;
delete base.T3_FIRST_OFF;

// [label, stdin, extra env, expected: "deny" | "context" | "silent"]
const cases = [
  ["Agent in T3", '{"tool_name":"Agent","tool_input":{}}', { T3CODE_THREAD_ID: "t" }, "deny"],
  ["Workflow in T3", '{"tool_name":"Workflow","tool_input":{}}', { T3CODE_THREAD_ID: "t" }, "deny"],
  ["Task in T3", '{"tool_name":"Task","tool_input":{}}', { T3CODE_THREAD_ID: "t" }, "deny"],
  ["Agent in T3 with T3_FIRST_OFF", '{"tool_name":"Agent","tool_input":{}}', { T3CODE_THREAD_ID: "t", T3_FIRST_OFF: "1" }, "context"],
    ["Agent in T3 with T3_FIRST_OFF=0", '{"tool_name":"Agent","tool_input":{}}', { T3CODE_THREAD_ID: "t", T3_FIRST_OFF: "0" }, "deny"],
  ["Agent outside T3", '{"tool_name":"Agent","tool_input":{}}', {}, "context"],
  ["Workflow outside T3", '{"tool_name":"Workflow","tool_input":{}}', {}, "context"],
  ["empty T3CODE_THREAD_ID", '{"tool_name":"Agent","tool_input":{}}', { T3CODE_THREAD_ID: "" }, "context"],
  ["malformed stdin in T3", "{not json", { T3CODE_THREAD_ID: "t" }, "silent"],
  ["malformed stdin outside T3", "{not json", {}, "silent"],
];

let failed = 0;
for (const [label, stdin, env, expected] of cases) {
  const run = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8", env: { ...base, ...env } });
  let got = "silent";
  if (run.stdout.trim()) {
    const out = JSON.parse(run.stdout).hookSpecificOutput ?? {};
    got = out.permissionDecision === "deny" ? "deny" : out.additionalContext ? "context" : "silent";
  }
  const ok = run.status === 0 && got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  exit=${run.status}  ${got.padEnd(7)}  ${label}`);
}

// The routing reminder keeps councils for unresolved design trade-offs and routine fixes on one reviewer.
for (const env of [{}, { T3CODE_THREAD_ID: "t" }]) {
  const run = spawnSync(process.execPath, [hook], { input: '{"tool_name":"Agent","tool_input":{}}', encoding: "utf8", env: { ...base, ...env } });
  const out = JSON.parse(run.stdout).hookSpecificOutput ?? {};
  const text = out.additionalContext || out.permissionDecisionReason || "";
  const label = `routing text ${env.T3CODE_THREAD_ID ? "in" : "outside"} T3`;
  const checks = [
    ["council only for an unresolved design trade-off", text.includes("only for a genuine unresolved design trade-off")],
    ["routine fixes on one focused reviewer", text.includes("one focused cross-family reviewer by default, routine fixes included")],
    ["no plan-request council trigger", !text.includes("request to plan")],
    ["no file-count panel trigger", !text.includes("several files")],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${name}`);
  }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
