---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every spawn is a read-only `delegate_task` child (`role: "research"`). Explorers run on Grok (`grok` / `grok-4.7`, `reasoningEffort: "xhigh"`) and every explainer on Opus (`claudeAgent` / `claude-opus-5-5`, `effort: "xhigh"`); resolve the newest IDs with `orchestrator_capabilities`. If a model is unavailable, use the closest model of the same family and say so. Outside T3, spawn as `subagent-routing` §3 sets (your native tool for your own family, the other family's CLI otherwise), with the same models. In T3 never use the Claude `Task`/`Agent` tool, Codex `spawn_agent` or a CLI such as `claude -p` for these.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Start one explainer with `delegate_task` that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Start all explorers in parallel as `delegate_task` calls in one response, each with `references/explorer-prompt.md` and its angle filled in. Follow each delegate's `next`; do not poll.

## 3. Synthesize (complex only)

Once all explorers have returned, start one explainer with `delegate_task`, using `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
