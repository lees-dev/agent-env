# Skills and global rules

This page belongs to the rules+skills area. It covers where each skill comes from, how each harness finds skills and rules, and what this repo leaves out. `docs/layout.md` has the paths and naming rules.

## Layout

| Source in this repo | Deploys to | Who reads it |
|---|---|---|
| `home/dot_agents/skills/exact_<name>/` | `~/.agents/skills/<name>/` | Codex (user scope), Muse (user scope), Grok (`.agents/skills` at each tier) |
| `home/.chezmoiscripts/run_after_20-skills-links.{ps1,sh}.tmpl` | a link at `~/.claude/skills/<name>` → `~/.agents/skills/<name>` | Claude Code. Grok also scans `~/.claude/skills` and dedupes skills by name |
| `home/dot_agents/docs/agents/*.md` | `~/.agents/docs/agents/` | Linked from the rules: issue tracker, triage labels, domain docs, PR standards, subagent routing, T3-first, credentials, repo defaults |
| `home/.chezmoitemplates/rules/global.md` and `machine-<osFlavour>.md` | (partials) | The one source of the global rules |
| `home/dot_claude/CLAUDE.md.tmpl` | `~/.claude/CLAUDE.md` | Claude Code. Grok also reads it, through Claude compatibility |
| `home/dot_codex/AGENTS.md.tmpl` | `~/.codex/AGENTS.md` | Codex (default `CODEX_HOME`), and Muse's `/rules import` |
| `home/dot_grok/AGENTS.md.tmpl` | `~/.grok/AGENTS.md` | Grok (default `GROK_HOME`) |

- Each skill directory is `exact_`, so chezmoi removes any file the repo no longer has. `~/.agents/skills/` itself is not `exact_`, so vendor packs installed there survive an apply.
- A file that starts with `#!` gets the `executable_` prefix. One file has it: `pr-workflow/scripts/pr-workflow-hook.mjs`.
- Every file is LF in git (`.gitattributes`). The source files were already LF.
- The rules+skills block in `home/.chezmoiignore` skips a harness's rules file when that harness is not selected. It also keeps `~/.claude/skills/**` out of chezmoi's entries, because the run script makes those links.

## Skill links

`~/.claude/skills/<name>` is a link to `~/.agents/skills/<name>`, so the two copies cannot drift. On Windows the link is a directory junction, which needs neither Developer Mode nor elevation. Elsewhere it is a symlink.

`run_after_20-skills-links` makes the links after every apply. It is idempotent: a second run reports `31 ok`. The same script runs on every OS, as `docs/layout.md` requires. Unix does not use `symlink_` entries, because chezmoi would delete a real copy that differs without checking it first. For each canonical skill the script does this:

| What `~/.claude/skills/<name>` is | Action |
|---|---|
| The right link | Leaves it alone |
| Missing | Creates the link |
| A link to another place, or a dangling link | Records the old target in the backup manifest, then relinks |
| A real directory that is identical after LF normalisation | Moves it to `~/.agent-env-backups/<UTC>-skills-links/claude-skills/<name>`, then links |
| A real directory or file that differs | Leaves it and prints its name. `scripts/verify` fails until the owner resolves it |

Then it removes every link in `~/.claude/skills` that points into `~/.agents/skills` and dangles. That happens when a skill leaves the repo. The script never touches `~/.claude/skills/synced`, a vendor skill such as `higgsfield-*`, or any name outside the canonical list.

On Windows the script removes a junction with `[IO.Directory]::Delete(path, $false)`, which deletes the link and leaves the target. The script never uses `Remove-Item -Recurse` on a junction, because on Windows PowerShell 5.1 that can delete the contents of the target.

`scripts/backup.d/20-skills.list` names every `~/.agents/skills/<name>` directory and every `~/.claude/skills/<name>` path, so the base backup copies them before an apply. The skill directories are copied whole: each is `exact_`, so `chezmoi apply --force` deletes any file or link in it that the repo lacks, and those files are not in `chezmoi managed`.

To retire a skill:
1. Delete `home/dot_agents/skills/exact_<name>/`.
2. Delete its two lines (`.agents/skills/<name>` and `.claude/skills/<name>`) in `scripts/backup.d/20-skills.list`.
3. Apply. The link script prunes the link.
4. Delete `~/.agents/skills/<name>/` by hand, because chezmoi leaves it on disk. (`.chezmoiremove` belongs to foundation and is unchanged.)

## Rules

One template, `rules/global.md`, renders all three rules files. `.harness` turns a few sections on or off, and `.osFlavour` picks the machine fragment:

| Section | claude | codex | grok |
|---|---|---|---|
| Machine environment (`machine-windows`, `-wsl`, `-linux` or `-macos`) | yes | yes | yes |
| Claude desktop app (MSIX) caveat | Windows only | no | no |
| WSL2 (available, not the default) | Windows only | Windows only | Windows only |
| Stack, mattpocock defaults, where skills live, the useEffect rule, Linear | yes | yes | yes |
| Default way of working | Phase-by-phase through T3 delegates (`delegate_task`); Workflow only outside T3 | Phase-by-phase, every subagent routed by `subagent-routing`, `delegate_task` inside T3 | as codex |
| Plan in detail; issue batches in T3 (one thread per issue) | yes | yes | yes |
| pr-workflow | `/pr-workflow` | `~/.agents/skills/pr-workflow/SKILL.md` | as codex |
| Engineering standards | `include` of `home/dot_agents/docs/agents/pr-standards.md` between BEGIN/END markers | same | same |
| Subagent routing | `include` of `home/dot_agents/docs/agents/subagent-routing.md` in a second managed block | same | same |
| T3-first, credentials, repo defaults | `include` of `t3-first.md`, `credentials.md` and `repo-defaults.md` from the same folder, one managed block each | same | same |

The wording is the owner's. It comes verbatim from three files: `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` on Beast (2026-11-04), and `~/.claude/CLAUDE.md` on WSL. Merging them made these changes:
- Codex and Grok now get the Linear section and the decision that the factory is retired. The old Codex file had neither. The old Grok file had only the standards block.
- The Codex shells line said "PowerShell". It now says "PowerShell 5.1", as the Claude file did.
- The `linux` and `macos` machine fragments are new and short. They repeat this repo's own rules: on `server`, install user-level only, with no sudo, dnf or system units.
- A new subsection, "Where skills and these rules live", says to edit the repo and not the deployed file.
- The BEGIN marker names the source in this repo. `~/bin/sync-agent-standards` was the interim tool that wrote the same five blocks with its own marker. agent-env now ships all five, so it supersedes the tool: `scripts/verify` fails when a rules file lacks any of the five `managed by agent-env` blocks (for example after the old tool rewrote one), and only prints an INFO line while the tool still exists. This repo does not edit anything under `~/bin/`.

On 2026-11-06 the hand-written sections (agent skills, default way of working, plan in detail, issue batches in T3, Linear, pull requests) were synced from the owner's live `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`; the rendered Claude and Codex files match them apart from the BEGIN markers. The five managed documents were synced from the live `~/.agents/docs/agents/` the same day.

The engineering-standards block in this repo's `AGENTS.md` is byte-identical to `home/dot_agents/docs/agents/pr-standards.md` (2026-11-06). Change both in the same commit.

### Grok reads the rules twice

On Beast (Grok 1.0.70), `grok inspect --json` lists two global instruction files: `~/.grok/Agents.md` and `~/.claude/Claude.md`. Grok turns Claude compatibility on by default. Grok's bundled `05-configuration.md` says `[compat.claude] agents = false` stops the `~/.claude/` scan, but a test with a throwaway home on 2026-11-04 showed that neither `agents = false` nor `rules = false` removes `~/.claude/Claude.md` from `grok inspect --json` (both cells did report `source: config`). So agent-env sets neither, and `scripts/verify` prints an INFO line. Grok reads the global rules twice; the Claude-only sections (ultracode, the MSIX caveat) reach Grok too. Retest after each Grok bump.

### Muse: run `/rules import` once

Muse Code 1.4.14 has no global rules file that this repo can write. Its path is [UNVERIFIED]. Muse's `/rules import` copies `~/.claude/CLAUDE.md` or `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) into its own user rules file and adds a provenance header. The strings in the binary show this. After the first apply on a machine with Muse:

1. Start `muse` in any directory.
2. Run `/rules import`. Pick the Codex file, because it is harness-neutral: it has no Workflow tool and no MSIX caveat. Choose **Overwrite** if Muse already has a user rules file.
3. Run it again each time the rules change. The import is a copy, so later changes do not reach Muse on their own.

Muse reads skills straight from `~/.agents/skills`: `muse skills list` shows `$HOME/.agents/skills/<name>/SKILL.md`. Skills need no import. Muse also has a setting named `context.foreign_personal_rules`. The binary suggests it loads the Claude and Codex files live. Its effect and its default are untested [UNVERIFIED]. That setting belongs to the harness area (`modify_settings.json`).

## Canonical skills (31)

The original sources were `~/.claude/skills` and `~/.agents/skills` on Beast, on 2026-11-04. When the two copies of a skill differed, the copy with the newest file mtime won. Only `council` differed. `synced/` was skipped, and so were the skills that `vendor-skills.lock` lists.

On 2026-11-05, `council` and `pr-workflow` were refreshed from the live `~/.claude/skills` copies on BEAST. `subagent-routing` was added from the same source and replaces the retired routing roster. Both managed standards documents were synced from `~/.agents/docs/agents/`. Source files were read only.

On 2026-11-06, 16 skills were refreshed from the owner's live `~/.agents/skills` (the T3-first and land-pr rewrite): `babysit-pr`, `blast-radius`, `correct`, `council`, `create-verification-skill`, `file-pr`, `full-send`, `full-stop`, `herdr`, `how`, `maintain-verification-skill`, `modernize`, `pr-workflow`, `sol-loop`, `subagent-routing` and `takeover`. The live copies retired three files, which leave the repo too: `babysit-pr/scripts/pr-wait` (T3 `watch_pull_request` replaces it), and `pr-workflow/references/cost-model.md` and `workflow-patterns.md` (the no-CI workflow has no runner costs). `subagent-routing` gains `references/issue-threads.md` and its own `scripts/test-hook.mjs`. Two private names were replaced with generic ones (a repository in a `pr-workflow` example and in its hook test).

The tree sha256 is the sha256 of these lines, sorted bytewise by relpath: `<target relpath>\t<sha256 of the file with CRLF turned to LF>\n`. `run_after_20-skills-links` computes the same hash.

| Skill | Copy used | Files | Tree sha256 (LF) |
|---|---|---|---|
| `babysit-pr` | `~/.agents/skills` (2026-11-06) | 1 | `5f18b31abf71f7599531cd38b0ab8854f05cd667a88788905dd2267c62c1addd` |
| `blast-radius` | `~/.agents/skills` (2026-11-06) | 1 | `63cfa68e3114c9df352eeed367ed19b360de904a45085bcc945df4cbbbf0d354` |
| `correct` | `~/.agents/skills` (2026-11-06) | 1 | `5fe5b4ed3ad388333f973c233f53c20da26a19fe27fb712d0a69d34d7b6b4dbf` |
| `council` | `~/.agents/skills` (2026-11-06) | 1 | `e146d54dbadb6be4a4e063f086bb8b17ae2b957c6b7fdb094254a90e5c376ea9` |
| `create-verification-skill` | `~/.agents/skills` (2026-11-06) | 4 | `e925605e281747f1c7fcc8d3a2c17fe86056938a47145bc9a4d7986a70e370db` |
| `file-pr` | `~/.agents/skills` (2026-11-06) | 1 | `5dbe2a12a0543cc4d5c773d8e7170e23a969d42621d29557a8bc2d986f3a4ad8` |
| `full-send` | `~/.agents/skills` (2026-11-06) | 2 | `b1acb74410c8c4528bad24c8102219ffbc15e3be2baa13cd1df4fa7602d13c7a` |
| `full-stop` | `~/.agents/skills` (2026-11-06) | 2 | `05f49da5dc201a6c4a73e9cc608066b8c0199c56abab9789a69190cb088cd64b` |
| `herdr` | `~/.agents/skills` (2026-11-06) | 1 | `8c9f01af045c4d01ec4faae51bfdf12358d24691f4ec1d43c87dcd53dedb53fb` |
| `how` | `~/.agents/skills` (2026-11-06) | 3 | `a05f3e51167a925f215d309b3790543185e386b4bcfdd93fee291d471c47f716` |
| `kun` | identical in both | 1 | `c5cafaca2a3c140002f140e96af2a2eb77423fe7d89251bef59e2b5577833892` |
| `leaving-pr-comments` | identical in both | 2 | `247ef56da1e550f14cc3b87cab818378f714c461fb42aa4ea441def39e03e661` |
| `maintain-verification-skill` | `~/.agents/skills` (2026-11-06) | 1 | `7bb23921fde2e10024b0927a163abea4a783c4b8c7e17b79877bd68f77aa5ef1` |
| `modernize` | `~/.agents/skills` (2026-11-06) | 2 | `0186bfc60db5655fc52b60487797b8a2b98d1d8a166cc46bca87c949ad556b3d` |
| `pr-workflow` | `~/.agents/skills` (2026-11-06), public examples | 4 | `20b86f5e7d25e07fa1dd489939648fd2e2927e60386390532a299953b2686f25` |
| `principle-boundary-discipline` | identical in both | 1 | `cb9a0b008885757b969430d0f85b4edb6ba5b41994455474c3f9b7f2a5d341d0` |
| `principle-encode-lessons-in-structure` | identical in both | 1 | `f4c2345b2b07f5c6a067012c58325f36bd98ab40e3bc470c8414dc29ebbe89be` |
| `principle-fix-root-causes` | identical in both | 1 | `2317a5ac92561c97fe4609b5a54f4379a35a2b7c542aa92f0dc3344d5e4b6959` |
| `principle-laziness-protocol` | identical in both | 1 | `584157ba2043e5f9c47c9a323638e6becd1422028333cefb501ca6b7c64bb499` |
| `principle-minimize-reader-load` | identical in both | 1 | `31d25dea844942f10fdebf53d65dbe8b28aba87fdbb1161757bee4254e893301` |
| `principle-model-the-domain` | identical in both | 1 | `9959914e72e65b712d2397d6bb77a2bf5cce931e81903e32f120f06048e0f378` |
| `principle-prove-it-works` | identical in both | 1 | `76c637d1c35f494d27d590bbb4b3d7cc7a29710a73553798f0179bc9237a3ac3` |
| `principle-subtract-before-you-add` | identical in both | 1 | `91cf90d82d8aeca82c237753b2022b0ca836cdb20d1b200a5b80d5ce4aef185a` |
| `principle-type-system-discipline` | identical in both | 1 | `6a3a9db88195d3863d0a4ead13b68d5f6d996d142cdd1d04c20f9ee0c6922c1d` |
| `react-best-practices` | identical in both | 49 | `81afad38880a4b945e92056485b04a3a75082818bb62094bbdc5329c8d82b7c1` |
| `sol-loop` | `~/.agents/skills` (2026-11-06) | 1 | `a9177def69cf130930cfffc2e909988e4f1faa93b917de44d63af29f6b4b2077` |
| `subagent-routing` | `~/.agents/skills` (2026-11-06) | 4 | `50a62c3d0280092e2f479c2774427cc4d95fc4fa60f8255afb23fc60bc299884` |
| `takeover` | `~/.agents/skills` (2026-11-06) | 1 | `49e3728a144a614f49939c104370d184e5a0c1588d2e8009d6baf52571cb70e7` |
| `technical-writing` | identical in both | 1 | `a8ca05d14bccb71b3ad671ed5b858cf1b45c555fcb6eda68c9e0a70d3e4585d6` |
| `typescript-best-practices` | identical in both | 2 | `12d7a54225c5632d9dd5b837cfc89eaaf93b13ab181cc4e410db1e8e660f0f6c` |
| `unslop` | identical in both | 1 | `8f6ab7d04f0f8af7ee54b3cf842044ef1ddbb79fb22263e18c75895668d10c9f` |

The live BEAST `~/.claude/skills/council` is the authoritative copy for this refresh. A differing deployed copy remains subject to the link script's backup and conflict checks.

To recompute a tree hash (Python 3, read-only):

```sh
python3 -I -c 'import hashlib,os,sys
r=sys.argv[1];L=[]
for d,_,fs in os.walk(r):
  for f in fs:
    p=os.path.join(d,f);b=open(p,"rb").read();b=b if b"\0" in b else b.replace(b"\r\n",b"\n")
    L.append("%s\t%s\n"%(os.path.relpath(p,r).replace(os.sep,"/"),hashlib.sha256(b).hexdigest()))
print(hashlib.sha256("".join(sorted(L,key=str.encode)).encode()).hexdigest())' ~/.agents/skills/council
```

## Privacy scan before the copy

Before the copy, every file in the 31 skills and the four `docs/agents` files was scanned for:
- `sk-` keys and PEM headers;
- GitHub, Tailscale, 1Password and Slack tokens;
- email addresses, tailnet IPs and private IPs;
- bearer headers and `key=` or `token=` assignments;
- personal home paths, the tailnet name and client words.

Results:
- No secrets, emails, IPs or home paths.
- Repository-specific examples in `pr-workflow` use generic names in the public copy.
- No skill was excluded. The public-readiness pass replaces private repository examples and server-specific review commands. The deployed `pr-workflow` hash below includes those edits.

`scripts/secret-guard.sh` and gitleaks scan the copies again on every commit.

## Vendor packs (installed by their own tools)

`vendor-skills.lock` lists the skill names. `versions.toml` `[skills.*]` holds the pins.

| Pack | Pin (resolved 2026-11-04) | How it installs | Today |
|---|---|---|---|
| mattpocock-skills | 1.3.2 (`d1478fc`) | Claude Code plugin `mattpocock-skills@mattpocock`. For `~/.agents/skills`: `npx skills add mattpocock/skills` | Beast's plugin is 1.3.2. Beast `~/.agents` and WSL have 1.3.1 copies (CRLF on Beast) |
| higgsfield | 0.14.0 (`4d07574`; the repo has no tags) | Higgsfield CLI `@higgsfield/cli` 1.2.2, then `npx skills add higgsfield-ai/skills` | 0.14.0 on Beast, in `~/.claude/skills` only (CRLF). 0.13.0 on WSL |
| typesafe | 0.6.2 (`302eea6`) | Claude Code plugin `typesafe@typesafe-ai` | 0.5.7 plugin and an `npx skills` copy on WSL. server has it too |

Three skills were left out because they exist only outside the Windows sources: `hard-problem-resolution` and `no-mistakes` (WSL only), and `waves` (dangling links on server). The owner decides whether they join the repo.
