# Domain Docs

How the engineering skills should consume and create a repo's domain documentation. Layout: **single-context**, with **all docs under `docs/`**.

## Docs always live in `docs/`

Every document a skill creates goes under the repo's `docs/` folder, never the repo root. Wherever a skill says a file lives "at the repo root", use the `docs/` path instead:

| Skill default                 | Use instead                      |
| ----------------------------- | -------------------------------- |
| `GLOSSARY.md`                 | `docs/GLOSSARY.md`               |
| `GLOSSARY-MAP.md`             | `docs/GLOSSARY-MAP.md`           |
| `docs/adr/`                   | `docs/adr/` (unchanged)          |
| `CODING_STANDARDS.md`         | `docs/CODING_STANDARDS.md`       |
| `.out-of-scope/`              | `docs/out-of-scope/`             |
| specs / PRDs written to files | `docs/specs/`                    |
| per-repo skill config         | `docs/agents/` (unchanged)       |

Exceptions, which stay at the repo root because tools look for them there: `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `CHANGELOG.md`.

When reading, check `docs/` first and fall back to the root location for repos that predate this convention. If you find a root `GLOSSARY.md` or `CODING_STANDARDS.md`, suggest moving it into `docs/` rather than creating a second copy.

## Before exploring, read these

- **`docs/GLOSSARY.md`**, or
- **`docs/GLOSSARY-MAP.md`** if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── README.md
├── CLAUDE.md / AGENTS.md
├── docs/
│   ├── GLOSSARY.md
│   ├── CODING_STANDARDS.md
│   ├── adr/
│   │   ├── 0001-event-sourced-orders.md
│   │   └── 0002-postgres-for-write-model.md
│   ├── specs/
│   ├── out-of-scope/
│   └── agents/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
