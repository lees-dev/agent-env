{{- /*
  The one source for the global agent rules. Rendered into ~/.claude/CLAUDE.md,
  ~/.codex/AGENTS.md and ~/.grok/AGENTS.md (docs/skills.md, "Rules").
  Call it with the chezmoi data plus a harness name:
    {{ includeTemplate "rules/global.md" (merge (dict "harness" "claude") .) }}
  .harness is one of claude, codex, grok. Text outside the conditionals is the owner's
  wording, kept verbatim from the hand-kept files it replaced.
*/ -}}
<!-- Managed by agent-env (chezmoi). Edit home/.chezmoitemplates/rules/ in the agent-env repo, then chezmoi apply. Local edits here are overwritten. -->

{{ includeTemplate (printf "rules/machine-%s.md" .osFlavour) . }}
## Stack

- Frontend: React + StyleX. Backend: Java / Spring Boot. IDE: JetBrains (IntelliJ IDEA / WebStorm via JetBrains Toolbox).

## Agent skills (mattpocock/skills)

User-level defaults for every repo. If a repo has its own `docs/agents/*.md`, those win. When running `/setup-matt-pocock-skills` in a repo, use these answers without asking again: GitHub, default labels, docs in `docs/`.

### Issue tracker

GitHub Issues on the repo's GitHub remote, via the `gh` CLI. See `~/.agents/docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), one state label per issue, and GitHub's default labels for type. See `~/.agents/docs/agents/triage-labels.md`.

### Domain docs

Single-context. All docs a skill creates live under `docs/` (`docs/GLOSSARY.md`, `docs/adr/`, `docs/CODING_STANDARDS.md`, `docs/specs/`, `docs/out-of-scope/`), never the repo root. See `~/.agents/docs/agents/domain.md`.

### Where skills and these rules live

- Each user skill has one copy, in `~/.agents/skills/<name>/`.{{ if eq .harness "claude" }} `~/.claude/skills/<name>` is a link to it ({{ if eq .linkMode "junction" }}a directory junction{{ else }}a symlink{{ end }}), so the two cannot drift.{{ end }}
- The agent-env repo deploys the skills, this file and `~/.agents/docs/agents/*.md` with chezmoi. Change them in that repo, never in place: the next `chezmoi apply` overwrites a local edit.

## React: never write useEffect

- Never write `useEffect` or `useLayoutEffect` (captain's rule for every project, from Lauren Tan / poteto: agents predictably misuse effects, so we do not write them at all).
- Use instead: derive values during render; reset state with a `key`; put logic in event handlers; use `useSyncExternalStore` for external stores; fetch with the framework's data loading (server components, loaders, React Query/SWR) rather than effects.
- Load the `react-best-practices` skill for React work; its useEffect anti-patterns section has the replacements.
- The only exception is a hook inside a project's audited external-sync wrapper folder (for example `src/ui/effects/` or `src/renderer/src/hooks/external-sync/`), for genuine subscriptions, timers, DOM or browser APIs. Add one there only when nothing above can work, and say why in the PR.
- Existing effects stay until migrated; never add new ones, and lint/CI baselines may only shrink.
{{- if eq .harness "claude" }}

## Default way of working: ultracode dynamic workflows

- In every repo, treat ultracode as on: for every substantive task, work phase by phase (scout inline, then understand → design → implement → adversarial review), and route each phase's agents with the `subagent-routing` skill. Claude-routed fan-out (search, reading, research) runs as a Workflow; load the `workflow-authoring` skill before writing a script. GPT, Muse and Grok stages (building, cross-family review) run as `delegate_task` calls from the main thread between workflows. Work solo only for conversational turns and trivial mechanical edits.
- The agent factory is retired (owner decision 2026-11-04): no `factory` CLI, scheduler, `agent-ready`/lane dispatch or worker hand-offs. Run the work from this thread, with subagents routed by `subagent-routing`. Where a repo's AGENTS.md still describes factory dispatch, keep its other rules (branches, PR size, gates, research) and run the work as workflows.
{{- else }}

## Default way of working

- For every substantive task, work phase by phase (scout inline, then understand, design, implement, and adversarial review). Route every subagent with the `subagent-routing` skill, setting its model and effort explicitly. Use the spawn tool for the routed model family.
- The agent factory is retired (owner decision 2026-11-04): no `factory` CLI, scheduler, `agent-ready`/lane dispatch or worker hand-offs. Run the work from this thread, with subagents routed by `subagent-routing`. Where a repo's AGENTS.md still describes factory dispatch, keep its other rules (branches, PR size, gates, research).
{{- end }}

## Keep Linear current

- Update every Linear ticket that a piece of work touches, as the work happens: set its status, comment with findings and PR links, and note superseded decisions on the older tickets too. Linear is the source of truth.
{{ if eq .harness "claude" }}
## Pull requests: load /pr-workflow

- Load the `pr-workflow` skill (`/pr-workflow`) before briefing anyone to build a PR, and before opening, pushing to, updating, re-running CI on or merging any pull request, in every repo. It keeps CI runs and runner minutes down. The repo's own AGENTS.md / CLAUDE.md / PR template and gate docs win where they differ.
{{ else }}
## Pull requests: load pr-workflow

- Load the `pr-workflow` skill (`~/.agents/skills/pr-workflow/SKILL.md`) before briefing anyone to build a PR, and before opening, pushing to, updating, re-running CI on or merging any pull request, in every repo. It keeps CI runs and runner minutes down. The repo's own AGENTS.md / PR template and gate docs win where they differ.
{{ end }}
<!-- BEGIN engineering-standards (managed by agent-env; edit home/dot_agents/docs/agents/pr-standards.md in the agent-env repo) -->
{{ include "dot_agents/docs/agents/pr-standards.md" | trim }}
<!-- END engineering-standards -->

<!-- BEGIN subagent-routing (managed by agent-env; edit home/dot_agents/docs/agents/subagent-routing.md in the agent-env repo) -->
{{ include "dot_agents/docs/agents/subagent-routing.md" | trim }}
<!-- END subagent-routing -->
