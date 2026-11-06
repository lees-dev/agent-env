---
name: council
description: Use when explicitly asked to convene a council, or when a genuine design trade-off remains unresolved after your own investigation, where Grok sits as a full fourth member.
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
- Muse Wonder Full (for example `muse-wonder-full-1.0-contributor`, via the
  Muse Code harness; pick the `-contributor` variant when the list has one)

Do not use Gemini; it is not available here.

**Planning council.** When the request is planning (research toward a plan,
architecture, design or approach choice, a spec, a migration plan), Grok
(for example `grok-4.7`, via the Grok harness) joins from the start as a full
fourth member, so all four model families take part. Planning members are
read-only. Use the planning council only when the user asks for one, or
when viable approaches remain whose trade-offs your own investigation
cannot settle. A request to plan, a new feature, a migration or a spec is
not by itself a reason, and routine fixes never are. Ask each member for its
own research, proposal, risks and open questions; then compare them, graft
the best ideas onto the strongest proposal, and say who proposed what. If
they split on the approach and you cannot resolve it with evidence, ask the
user. For planning, use high effort on
all four. Planning ends with the plan: return it. The fix-and-review loop
below applies only when the user asked for implementation or a review.

For reviews and feedback, keep the latest flagship Grok model as a reserve
judge. Add it as a fourth delegate only when:

- the three delegates split on a verdict and you need a tie-breaker (a
  council exception: `subagent-routing`'s fresh-Sol tie-break is for the
  review panel, not council), or
- one of the three default members cannot be reached. Report the outage,
  then use Grok in its place (a council exception to `subagent-routing`'s
  no-substitution rule).

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel, with effort and
`role` set (see `subagent-routing`). Pick the newest matching model IDs from
that list rather than the examples above. Follow each delegate's `next`; do
not poll. Never fall back to native subagent tools, `claude -p` or
`codex exec` in T3. Outside T3, spawn as `subagent-routing` §3 sets (your native tool for your
own family, the other family's CLI otherwise). If you still cannot reach three providers (four for planning), or a member the user named is unavailable, report it instead of
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

If Grok joined (planning member or reserve judge), add a row for it.

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes (beyond a small
fix, through an Opus builder when you are not Opus), then request a
fresh review: a new `delegate_task` per delegate with the updated diff, prior
findings and objections (never `t3_thread_send` to a finished delegate). Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.
