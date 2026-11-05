---
name: council
description: Trigger this if the user says 'council'.
---

# Council

Before an audit, address outstanding PR comments, fix known issues, and run
relevant checks. Give council the updated implementation; do not defer known
fixes until reviews return. If the user wants to discard the implementation
and explore new ideas, skip fixes to code being replaced.

Bring in three delegates to help with the user's request, usually for review
or feedback. Use one strong model from each of three different providers, at
high reasoning effort. If the user's instructions name council members, use
those. Otherwise use the latest flagship model of each of these three:

- Claude Opus (for example `claude-opus-5-5`)
- GPT Sol (for example `gpt-6.1-sol`, via Codex)
- Muse Wonder Full (for example `muse-wonder-full-1.0`, via the Muse Code
  harness)

Do not use Gemini; it is not available here.

Keep the latest flagship Grok model (for example `grok-4.7`, via the Grok
harness) as a reserve judge. Add it as a fourth delegate only when:

- the three delegates split on a verdict and you need a tie-breaker, or
- one of the three default members cannot be reached. Report the outage,
  then use Grok in its place.

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Pick the
newest matching model IDs from that list rather than the examples above.
Elsewhere, use the harness's subagent tools. If you still cannot reach three
providers, or a member the user named is unavailable, report it instead of
substituting.

Give each delegate the request and relevant context. For review or feedback,
keep their work read-only. Collect their responses and summarize the useful
findings, disagreements, and recommended next steps.

For a code review, ask each delegate for a score out of 10.
Count each full review pass as one round.
A fresh review after fixes starts a new round.

If the work ends in a pull request, put the results in the PR description.
Put this section before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 7/10 | 9/10 |
| GPT Sol | 8/10 | 10/10 |
| Muse Wonder Full | 7/10 | 9/10 |
```

If Grok joined as a reserve judge, add a row for it.

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.
