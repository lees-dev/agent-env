## Subagent routing (owner, 2026-11-05)

Applies to every agent harness: Claude Code, Codex, Grok, Muse Code and any other.

- **Route every agent you start.** Before spawning any subagent, delegate, workflow agent, reviewer, council member or second opinion, load the `subagent-routing` skill (`~/.agents/skills/subagent-routing/SKILL.md`, also `~/.claude/skills/subagent-routing`). It maps each task type to a model family, model ID and effort level. An unrouted agent inherits your own model, which is the failure this rule stops.
- **The target family picks the spawn tool.** Same family as you: your native tool (Claude `Agent`/`Workflow`, Codex `spawn_agent`) with the model set. Any other family: T3 Code's `delegate_task` with `target.providerInstanceId`, `target.model` and effort set, or that harness's CLI outside T3.
- **Reviews cross families.** A reviewer's model family differs from the builder's, unless a named workflow skill (`council`, `sol-loop`) sets its own reviewers.
