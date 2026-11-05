# Triage Labels

The skills speak in terms of five canonical triage roles. These are the default label strings for every repo (the skill's recommended set, unchanged).

| Role              | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`    | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Conventions

- **Exactly one triage-state label per open issue.** When moving an issue to a new state, remove the old state label in the same `gh issue edit` call.
- **Type is separate from state.** For the kind of work, reuse GitHub's built-in default labels (`bug`, `enhancement`, `documentation`, `question`, `duplicate`, `good first issue`, `help wanted`) instead of inventing new ones.
- **Reuse before creating.** Check `gh label list` first. If a repo already has an equivalent label under another name, use that one rather than creating a duplicate.
- **Create missing labels on first use** with a description, so they're self-explanatory in the GitHub UI, e.g. `gh label create ready-for-agent --description "Fully specified, ready for an AFK agent" --color 0E8A16`.
