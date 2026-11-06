// repo-defaults: bring a repo to the agent standard without overwriting repo-owned text.
//
// Usage: node apply.mjs [--inspect | --check | --apply] [--repo <path>] [--json] [--offline]
//   --inspect (default)  report everything; write nothing; exit 0
//   --check              exit 1 on drift (block missing or outdated, CLAUDE.md import, t3.json,
//                        .agents/repo.json, gitignore lines); warnings do not fail
//   --apply              fix the drift: insert or refresh the managed AGENTS.md block, prepend
//                        `@AGENTS.md` to CLAUDE.md (or create it), create or merge t3.json, create
//                        .agents/repo.json from detection (or add missing keys), append gitignore
//                        lines, create docs/agents/repo.md. Repo-owned text is never rewritten.
//   --offline            do not call gh (no ruleset listing)
// Also reports, for a separate PR: PR-gating workflows and rulesets to remove, env files to
// migrate into 1Password (`agent-secret import`), and TODO(repo-defaults) markers to fill in.
// Node >= 22, no dependencies. Prints names and counts, never file values.
// Processes start through the lifecycle libs deployed next to the skills (~/.agents/bin/lib, the
// same relative path in this repo's source): shell: false, Windows .cmd shims resolved, and no
// child ever gets OP_SERVICE_ACCOUNT_TOKEN.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripToken } from '../../../bin/lib/op.mjs';
import { run } from '../../../bin/lib/proc.mjs';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const BLOCK_RE = /<!-- BEGIN agent-standard v(\d+)[^>]*-->[\s\S]*?<!-- END agent-standard -->/g;
const GITIGNORE_LINES = ['.env.local', '.env.local.pre-op'];
const TODO = 'TODO(repo-defaults)';

function child(cmd, args, cwd, opts = {}) {
  return run(cmd, args, { cwd, env: stripToken(process.env), ...opts });
}

function git(args, cwd) {
  const r = child('git', args, cwd);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), status: r.status };
}

function readText(p, root) { try { inside(root, p); return fs.readFileSync(p, 'utf8'); } catch { return null; } }
// A file this script may write: its text, or null only when it does not exist. One that exists
// but cannot be read (a directory, no read permission) throws Unreadable: the item is then
// invalid and nothing is written, so an existing file is never replaced unseen.
class Unreadable extends Error {}

// Where p really is: the existing part resolved through every link (its parent folders
// included), plus the part that does not exist yet.
function realLocation(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// A repo cannot make this script read or write outside itself: a managed file, or a folder on
// its way, that links outside the repo makes the item invalid. Links inside the repo are fine.
function inside(root, p) {
  const rel = path.relative(fs.realpathSync(root), realLocation(p));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Unreadable('resolves outside the repo (a link): fix by hand');
}

function readOwned(p, root) {
  inside(root, p);
  try { return fs.readFileSync(p, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Unreadable(`exists but cannot be read (${e.code || e.message}): fix by hand`);
    // A link to nothing exists too: never write through it or replace it.
    let link = false;
    try { link = fs.lstatSync(p).isSymbolicLink(); } catch { /* really missing */ }
    if (link) throw new Unreadable('is a link to a file that does not exist: fix by hand');
    return null;
  }
}
function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
function withEol(text, eol) { return eol === '\n' ? text : text.replace(/\r?\n/g, eol); }
function asset(name) { return fs.readFileSync(path.join(ASSETS, name), 'utf8').replace(/\r\n/g, '\n'); }
// Write without ever leaving a half-written file: the text goes to a temp file next to the real
// target, which then replaces it in one rename (mode kept). A link stays a link: its target is
// what gets written, as a plain write through the link would.
function writeFile(p, text) {
  // The final file behind every link in a chain; links themselves are never replaced. (A link
  // to nothing never gets here: readOwned makes that item invalid.)
  let target = p;
  try { target = fs.realpathSync(p); } catch {
    // Missing, or a link to nothing: a link is never replaced by a file.
    let link = false;
    try { link = fs.lstatSync(p).isSymbolicLink(); } catch { /* really missing */ }
    if (link) throw new Unreadable('is a link to a file that does not exist: fix by hand');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let st = null;
  try { st = fs.statSync(target); } catch { st = null; }
  const mode = st ? st.mode & 0o777 : undefined;
  const tmp = `${target}.repo-defaults-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    // A file with several hard links (CLAUDE.md as a hard link to AGENTS.md) must keep its
    // inode, so every name sees the new text: copy the finished temp file over it in place.
    // That one case is not atomic; every other write is a rename.
    if (st && st.nlink > 1) { fs.copyFileSync(tmp, target); fs.unlinkSync(tmp); } else fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}
// Every fix writes through this: inside the repo, and never replacing a link.
function writeIn(root, p, text) {
  inside(root, p);
  writeFile(p, text);
}
function json(text) { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; } }
// A JSON object (not null, not an array, not a scalar).
function jsonObject(text) {
  const p = json(text);
  return p.ok && p.value !== null && typeof p.value === 'object' && !Array.isArray(p.value) ? p.value : null;
}
// Same file on disk (links, junctions and hard links included).
function sameFile(a, b) {
  try {
    if (fs.realpathSync.native(a) === fs.realpathSync.native(b)) return true;
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

export const BLOCK = asset('agents-block.md').trimEnd();
export const BLOCK_VERSION = Number(BLOCK.match(/agent-standard v(\d+)/)[1]);

// ------------------------------------------------------------------ items
// Each item returns { name, status: ok|missing|outdated|invalid|warn, detail, fix?: () => string }.
// missing/outdated/invalid are drift; fix() applies the change and returns what it did.

function agentsBlock(root) {
  const p = path.join(root, 'AGENTS.md');
  const text = readOwned(p, root);
  if (text === null) {
    return {
      name: 'AGENTS.md block', status: 'missing', detail: 'no AGENTS.md',
      fix: () => { writeIn(root, p, `${BLOCK}\n\n<!-- Repo-specific rules go below the block. Facts: docs/agents/repo.md and .agents/repo.json. -->\n`); return 'created AGENTS.md'; },
    };
  }
  const eol = eolOf(text);
  const blocks = [...text.matchAll(BLOCK_RE)];
  if (/<!-- BEGIN agent-standard/.test(text) && !blocks.length) {
    return { name: 'AGENTS.md block', status: 'invalid', detail: 'BEGIN marker without END: fix by hand' };
  }
  if (!blocks.length) {
    return {
      name: 'AGENTS.md block', status: 'missing', detail: 'no managed block',
      fix: () => { writeIn(root, p, `${withEol(BLOCK, eol)}${eol}${eol}${text}`); return 'inserted the block at the top of AGENTS.md'; },
    };
  }
  const found = blocks.map((b) => `v${b[1]}`).join(', ');
  if (blocks.length > 1) {
    // Which copy is the real one is the repo's call: report it, change nothing.
    return { name: 'AGENTS.md block', status: 'invalid', detail: `${blocks.length} managed blocks (${found}): keep one by hand` };
  }
  // A newer standard (from a newer skill) is never rewritten by this older one.
  if (Number(blocks[0][1]) > BLOCK_VERSION) {
    return { name: 'AGENTS.md block', status: 'invalid', detail: `${found} is newer than this skill's v${BLOCK_VERSION}: update repo-defaults (chezmoi apply) first` };
  }
  if (blocks[0][0].replace(/\r\n/g, '\n') === BLOCK) return { name: 'AGENTS.md block', status: 'ok', detail: `agent-standard v${BLOCK_VERSION}` };
  return {
    name: 'AGENTS.md block', status: 'outdated', detail: `${found}, want v${BLOCK_VERSION} text`,
    fix: () => {
      // Replace exactly the block's span; every other byte of the file stays as it was.
      const b = blocks[0];
      writeIn(root, p, `${text.slice(0, b.index)}${withEol(BLOCK, eol)}${text.slice(b.index + b[0].length)}`);
      return `refreshed the block in AGENTS.md (was ${found})`;
    },
  };
}

function claudeMd(root) {
  const p = path.join(root, 'CLAUDE.md');
  let st = null;
  try { st = fs.lstatSync(p); } catch { st = null; }
  if (!st) inside(root, p);
  if (!st) return { name: 'CLAUDE.md', status: 'missing', detail: 'no CLAUDE.md', fix: () => { writeIn(root, p, '@AGENTS.md\n'); return 'created CLAUDE.md (@AGENTS.md)'; } };
  // One file under two names (a link to it, or a hard link): already the same rules.
  if (sameFile(p, path.join(root, 'AGENTS.md'))) return { name: 'CLAUDE.md', status: 'ok', detail: 'same file as AGENTS.md' };
  if (st.isSymbolicLink()) {
    // Only a link to this repo's own AGENTS.md (which may not exist yet) is the same rules.
    const raw = fs.readlinkSync(p);
    const key = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
    return key(path.resolve(root, raw)) === key(path.join(root, 'AGENTS.md'))
      ? { name: 'CLAUDE.md', status: 'ok', detail: 'link to AGENTS.md' }
      : { name: 'CLAUDE.md', status: 'invalid', detail: `link to ${raw}, not this repo's AGENTS.md: fix by hand` };
  }
  const text = readOwned(p, root) ?? '';
  if (/^@AGENTS\.md\s*$/m.test(text)) return { name: 'CLAUDE.md', status: 'ok', detail: 'imports @AGENTS.md' };
  const eol = eolOf(text);
  return {
    name: 'CLAUDE.md', status: 'missing', detail: 'does not import @AGENTS.md',
    fix: () => { writeIn(root, p, `@AGENTS.md${eol}${eol}${text}`); return 'prepended @AGENTS.md to CLAUDE.md'; },
  };
}

const isSetup = (s) => /agent-worktree\.mjs"?\s+setup\b/.test(s?.command || '');
const isTeardown = (s) => /agent-worktree\.mjs"?\s+teardown\b/.test(s?.command || '');

function t3Json(root) {
  const p = path.join(root, 't3.json');
  const want = JSON.parse(asset('t3.json'));
  const text = readOwned(p, root);
  if (text === null) return { name: 't3.json', status: 'missing', detail: 'no t3.json', fix: () => { writeIn(root, p, `${JSON.stringify(want, null, 2)}\n`); return 'created t3.json'; } };
  const cur = jsonObject(text);
  if (!cur) return { name: 't3.json', status: 'invalid', detail: 'not a JSON object: fix by hand' };
  if (cur.scripts !== undefined && (!Array.isArray(cur.scripts) || cur.scripts.some((s) => s === null || typeof s !== 'object' || Array.isArray(s)))) {
    return { name: 't3.json', status: 'invalid', detail: 'scripts is not a list of objects: fix by hand' };
  }
  const scripts = cur.scripts || [];
  const problems = [];
  if (cur.defaultThreadEnvMode !== 'worktree') problems.push('defaultThreadEnvMode is not worktree');
  const setupIdx = scripts.findIndex(isSetup);
  const firstCreate = scripts.findIndex((s) => s?.runOnWorktreeCreate === true);
  const firstSettle = scripts.findIndex((s) => s?.runOnSettle === true);
  if (setupIdx < 0 || scripts[setupIdx].runOnWorktreeCreate !== true || scripts[setupIdx].async !== false) problems.push('no blocking Agent setup script');
  else if (firstCreate !== setupIdx) problems.push('another runOnWorktreeCreate script comes first (T3 runs only the first)');
  const tdIdx = scripts.findIndex(isTeardown);
  if (tdIdx < 0 || scripts[tdIdx].runOnSettle !== true) problems.push('no Agent teardown script');
  else if (firstSettle !== tdIdx) problems.push('another runOnSettle script comes first (T3 runs only the first)');
  if (!problems.length) return { name: 't3.json', status: 'ok', detail: 'worktree mode, engine scripts first' };
  return {
    name: 't3.json', status: 'outdated', detail: problems.join('; '),
    fix: () => {
      // Only an exact copy of a canonical engine script is dropped; anything else (including a
      // custom script that calls the engine and does more) is kept, as a manual script.
      const others = scripts.filter((s) => !isCanonical(s)).map((s) => {
        // Only the first create/settle script runs: ours. Keep the others as manual scripts.
        const c = { ...s };
        // `async` only matters for a create script; a script that was already manual keeps it.
        if (c.runOnWorktreeCreate) { c.runOnWorktreeCreate = false; delete c.async; }
        if (c.runOnSettle) c.runOnSettle = false;
        return c;
      });
      const out = { ...cur, defaultThreadEnvMode: 'worktree', scripts: [...want.scripts, ...others] };
      writeIn(root, p, `${JSON.stringify(out, null, 2)}\n`);
      const kept = scripts.filter((s) => !isCanonical(s));
      const demoted = kept.filter((s) => s.runOnWorktreeCreate || s.runOnSettle).length;
      const custom = kept.filter((s) => isSetup(s) || isTeardown(s)).length;
      const notes = [];
      if (demoted) notes.push(`${demoted} other automatic script(s) made manual: move that work into .agents/repo.json setup or .agents/hooks.mjs`);
      if (custom) notes.push(`${custom} custom script(s) that call agent-worktree kept: check them by hand`);
      return `updated t3.json${notes.length ? ` (${notes.join('; ')})` : ''}`;
    },
  };
}

// A copy of one of the canonical engine scripts: the same command (whitespace aside) and no
// field the canonical script lacks. One with extra repo fields is kept (and reported).
const norm = (c) => String(c || '').trim().replace(/\s+/g, ' ');
function isCanonical(s) {
  return JSON.parse(asset('t3.json')).scripts.some((w) => norm(w.command) === norm(s?.command)
    && Object.keys(s).every((k) => Object.hasOwn(w, k)));
}

// ------------------------------------------------------------------ detection

export function detect(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pkg = json(readText(path.join(root, 'package.json'), root) ?? 'null').value || null;
  let pm = null;
  let install = null;
  if (has('pnpm-lock.yaml')) { pm = 'pnpm'; install = 'pnpm install --frozen-lockfile'; }
  else if (has('bun.lock') || has('bun.lockb')) { pm = 'bun'; install = 'bun install --frozen-lockfile'; }
  else if (has('yarn.lock')) { pm = 'yarn'; install = 'yarn install --immutable'; }
  else if (has('package-lock.json')) { pm = 'npm'; install = 'npm ci --no-audit --no-fund'; }
  else if (pkg) { pm = 'npm'; install = null; }
  const scripts = pkg?.scripts || {};
  const gate = scripts.gate && pm ? `${pm} run gate` : null;
  const remote = git(['remote', 'get-url', 'origin'], root);
  const last = remote.ok ? remote.out.split(/[\\/:]/).filter(Boolean).pop()?.replace(/\.git$/i, '') : null;
  const repo = (last || path.basename(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  let base = head.ok ? head.out.replace(/^origin\//, '') : null;
  if (!base) for (const b of ['main', 'master']) if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], root).ok) { base = b; break; }
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const ports = deps.next ? { PORT: 3000 } : deps.vite ? { PORT: 5173 } : {};
  return { repo, base, pm, install, gate, hasPackageJson: Boolean(pkg), scriptNames: Object.keys(scripts), ports };
}

export function repoJsonFromDetection(d) {
  const t = JSON.parse(asset('repo.json'));
  return {
    ...t,
    repo: d.repo,
    base: d.base || 'main',
    itemPrefix: d.repo,
    ports: d.ports,
    setup: d.install ? [d.install] : d.hasPackageJson ? [`${TODO}: install command`] : [],
    gate: [d.gate || `${TODO}: gate command (lint, typecheck, build, affected tests)`],
    affectedGate: [d.gate || `${TODO}: affected-tests command`],
  };
}

function repoJson(root) {
  const p = path.join(root, '.agents', 'repo.json');
  const text = readOwned(p, root);
  const d = detect(root);
  if (text === null) {
    return {
      name: '.agents/repo.json', status: 'missing', detail: 'no .agents/repo.json',
      fix: () => {
        writeIn(root, p, `${JSON.stringify(repoJsonFromDetection(d), null, 2)}\n`);
        return `created .agents/repo.json (${d.pm || 'no package manager'}, base ${d.base || 'main'}${d.gate ? '' : `, gate ${TODO}`})`;
      },
    };
  }
  const cur = jsonObject(text);
  if (!cur) return { name: '.agents/repo.json', status: 'invalid', detail: 'not a JSON object: fix by hand' };
  const tmpl = repoJsonFromDetection(d);
  const missing = Object.keys(tmpl).filter((k) => !(k in cur));
  const bad = [];
  // A missing version is added like any other missing key; an explicit other one is refused.
  if (Object.hasOwn(cur, 'version') && cur.version !== 1) bad.push('version is not 1');
  if (cur.vault !== undefined && cur.vault !== 'agent-repos') bad.push('vault is not agent-repos');
  for (const k of ['setup', 'gate', 'affectedGate']) if (k in cur && !Array.isArray(cur[k])) bad.push(`${k} is not an array`);
  if (bad.length) return { name: '.agents/repo.json', status: 'invalid', detail: `${bad.join('; ')}: fix by hand` };
  if (missing.length) {
    return {
      name: '.agents/repo.json', status: 'outdated', detail: `missing keys: ${missing.join(', ')}`,
      fix: () => {
        const out = { ...cur };
        for (const k of missing) out[k] = tmpl[k];
        writeIn(root, p, `${JSON.stringify(out, null, 2)}\n`);
        return `added ${missing.length} key(s) to .agents/repo.json`;
      },
    };
  }
  return { name: '.agents/repo.json', status: 'ok', detail: 'v1' };
}

// Ignored by the repo's own root .gitignore: a global excludes file or .git/info/exclude is
// not shared with the next clone, so it does not count.
function ignoredByRepo(root, file) {
  const r = git(['check-ignore', '--no-index', '-v', '--', file], root);
  if (!r.ok) return false;
  const m = r.out.split('\t')[0].match(/^(.*?):(\d+):(.*)$/);
  return Boolean(m) && m[1] === '.gitignore' && !m[3].startsWith('!');
}

function gitignore(root) {
  const p = path.join(root, '.gitignore');
  const missing = GITIGNORE_LINES.filter((l) => !ignoredByRepo(root, l));
  if (!missing.length) return { name: '.gitignore', status: 'ok', detail: GITIGNORE_LINES.join(', ') };
  const current = readOwned(p, root) ?? '';
  return {
    name: '.gitignore', status: 'missing', detail: `not ignored: ${missing.join(', ')}`,
    fix: () => {
      const text = current;
      const eol = text ? eolOf(text) : '\n';
      const sep = text && !text.endsWith('\n') ? eol : '';
      writeIn(root, p, `${text}${sep}${text ? eol : ''}# agent-standard: secrets injected from 1Password (repo-defaults)${eol}${missing.join(eol)}${eol}`);
      return `added ${missing.length} line(s) to .gitignore`;
    },
  };
}

function repoMd(root) {
  const p = path.join(root, 'docs', 'agents', 'repo.md');
  if (readOwned(p, root) !== null) return { name: 'docs/agents/repo.md', status: 'ok', detail: 'present' };
  return { name: 'docs/agents/repo.md', status: 'missing', detail: 'no repo facts page', fix: () => { writeIn(root, p, asset('repo.md')); return 'created docs/agents/repo.md'; } };
}

// ------------------------------------------------------------------ reports (never drift)

function todos(root) {
  const files = ['.agents/repo.json', 'docs/agents/repo.md'];
  let n = 0;
  const where = [];
  for (const f of files) {
    const c = (readText(path.join(root, f), root) || '').split(TODO).length - 1;
    if (c) { n += c; where.push(`${f} (${c})`); }
  }
  return n ? { name: 'TODO markers', status: 'warn', detail: `${n} to fill in: ${where.join(', ')}` } : null;
}

// What an env file is for. Only a `source` (real values, not yet in 1Password) is suggested for
// `agent-secret import`: a template holds no values, `.env.local` is what worktree setup writes
// from `.env.op`, and `.env.local.pre-op` is a source that import already retired.
function envRole(f) {
  if (/^\.env\.(example|sample|template|dist)$/.test(f)) return 'template';
  if (f === '.env.local') return 'generated';
  if (f === '.env.local.pre-op') return 'retired';
  return 'source';
}

function envFiles(root) {
  const out = [];
  const tracked = (f) => git(['ls-files', '--error-unmatch', '--', f], root).ok;
  for (const f of fs.readdirSync(root)) {
    if (!/^\.env(\..+)?$/.test(f) || f === '.env.op') continue;
    const p = path.join(root, f);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      // A link: follow it only when its target is a file; a dangling one is listed as such.
      try { st = fs.statSync(p); } catch { out.push({ file: f, keys: 0, tracked: tracked(f), role: envRole(f), dangling: true }); continue; }
    }
    if (!st.isFile()) continue;
    const keys = (readText(p, root) || '').split(/\r?\n/).filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
    out.push({ file: f, keys, tracked: tracked(f), role: envRole(f) });
  }
  const op = readText(path.join(root, '.env.op'), root);
  const refs = op ? op.split(/\r?\n/).filter((l) => /=\s*["']?op:\/\//.test(l)) : [];
  const foreign = refs.filter((l) => !/op:\/\/agent-repos\//.test(l)).length;
  // `.env.op` must be committed. A broad rule (for example `.env*`) would make a new one
  // silently left out of `git add`; a tracked one is committed whatever the rules say.
  const envOpIgnored = !tracked('.env.op') && git(['check-ignore', '-q', '--no-index', '--', '.env.op'], root).ok;
  return { envOp: op === null ? null : { refs: refs.length, foreignVaultRefs: foreign }, envOpIgnored, files: out };
}

// Workflows that run on pull requests or the merge queue gate PRs; release/deploy ones do not.
function gatingWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readText(path.join(dir, f), root) || '';
    // The `on:` block runs to the next top-level key (or the end of the file).
    const on = text.match(/^(on|"on"|'on'):[^\n]*\n?(?:[ \t#][^\n]*\n?|\r?\n)*/m);
    const section = on ? on[0] : text;
    const triggers = ['pull_request_target', 'pull_request', 'merge_group'].filter((t) => new RegExp(`\\b${t}\\b`).test(section));
    if (triggers.length) out.push({ file: `.github/workflows/${f}`, triggers });
  }
  return out;
}

function rulesets(root, offline) {
  if (offline) return { skipped: 'offline' };
  const remote = git(['remote', 'get-url', 'origin'], root);
  const m = remote.ok ? remote.out.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i) : null;
  if (!m) return { skipped: 'origin is not on GitHub' };
  const r = child('gh', ['api', `repos/${m[1]}/${m[2]}/rulesets`], root, { timeout: 30000 });
  if (r.status !== 0) return { skipped: 'gh api failed (no gh, no access, or no network)' };
  const parsed = json(r.stdout).value;
  const list = Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  return { list: list.map((x) => ({ name: x.name, enforcement: x.enforcement, target: x.target })) };
}

// ------------------------------------------------------------------ main

// One item; an existing file it cannot read makes it invalid, with no fix.
function item(name, fn, root) {
  try { return fn(root); } catch (e) {
    if (e instanceof Unreadable) return { name, status: 'invalid', detail: e.message };
    throw e;
  }
}

export function evaluate(root, { offline = false } = {}) {
  const items = [
    item('AGENTS.md block', agentsBlock, root), item('CLAUDE.md', claudeMd, root), item('t3.json', t3Json, root),
    item('.agents/repo.json', repoJson, root), item('.gitignore', gitignore, root), item('docs/agents/repo.md', repoMd, root),
  ];
  const todo = todos(root);
  return {
    items, todo,
    detection: detect(root),
    env: envFiles(root),
    workflows: gatingWorkflows(root),
    rulesets: rulesets(root, offline),
  };
}

const DRIFT = new Set(['missing', 'outdated', 'invalid']);

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const known = new Set(['--inspect', '--check', '--apply', '--repo', '--json', '--offline', '--help']);
  for (const f of flags) if (!known.has(f)) { process.stderr.write(`unknown option ${f}\n`); return 2; }
  if (flags.has('--help')) { process.stdout.write('usage: node apply.mjs [--inspect|--check|--apply] [--repo <path>] [--json] [--offline]\n'); return 0; }
  const mode = flags.has('--apply') ? 'apply' : flags.has('--check') ? 'check' : 'inspect';
  const ri = argv.indexOf('--repo');
  const start = ri >= 0 ? path.resolve(argv[ri + 1] || '.') : process.cwd();
  const top = git(['rev-parse', '--show-toplevel'], start);
  if (!top.ok) { process.stderr.write('repo-defaults: not inside a git checkout\n'); return 2; }
  const root = path.resolve(top.out);
  const offline = flags.has('--offline') || mode === 'check';

  // The fixes need no ruleset listing: --apply lists rulesets once, for the final report.
  let ev = evaluate(root, { offline: offline || mode === 'apply' });
  const actions = [];
  const failed = [];
  if (mode === 'apply') {
    // A fix that fails is recorded and the others still run; every fix done is reported.
    for (const it of ev.items) {
      if (!DRIFT.has(it.status) || !it.fix) continue;
      try { actions.push(it.fix()); } catch (e) { failed.push({ name: it.name, error: e.code || String(e.message || e).split('\n')[0] }); }
    }
    ev = evaluate(root, { offline });
  }
  const drift = ev.items.filter((i) => DRIFT.has(i.status));
  const result = {
    mode, root, standard: `agent-standard v${BLOCK_VERSION}`, actions, failed,
    items: ev.items.map(({ name, status, detail }) => ({ name, status, detail })),
    drift: drift.length, todo: ev.todo?.detail || null,
    detection: ev.detection, env: ev.env, gatingWorkflows: ev.workflows, rulesets: ev.rulesets,
  };
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const L = [];
    for (const a of actions) L.push(`APPLIED ${a}`);
    for (const f of failed) L.push(`FAILED ${f.name}: ${f.error}`);
    for (const i of result.items) L.push(`${i.status === 'ok' ? 'OK   ' : 'DRIFT'} ${i.name}: ${i.detail}`);
    if (ev.todo) L.push(`WARN  ${ev.todo.name}: ${ev.todo.detail}`);
    if (ev.env.envOpIgnored) L.push('WARN  .env.op would be ignored by a .gitignore rule: add `!.env.op` to .gitignore so it is committed');
    if (mode !== 'check') {
      for (const e of ev.env.files) {
        const tracked = e.tracked && e.role !== 'template' ? ' (TRACKED IN GIT: remove it and rotate)' : '';
        if (e.dangling) L.push(`WARN  ${e.file}: a link to nothing`);
        else if (e.role === 'source') L.push(`INFO  ${e.file}: ${e.keys} keys${tracked}; migrate with agent-secret import`);
        else L.push(`INFO  ${e.file}: ${e.role}, ${e.keys} keys${tracked}`);
      }
      if (ev.env.envOp?.foreignVaultRefs) L.push(`WARN  .env.op: ${ev.env.envOp.foreignVaultRefs} reference(s) outside op://agent-repos/`);
      for (const w of ev.workflows) L.push(`INFO  PR-gating workflow ${w.file} (${w.triggers.join(', ')}): remove in a separate PR`);
      for (const r of ev.rulesets.list || []) L.push(`INFO  ruleset ${r.name} (${r.enforcement}): drop required checks and merge queue in the separate PR`);
      if (ev.rulesets.skipped) L.push(`INFO  rulesets not listed: ${ev.rulesets.skipped}`);
    }
    L.push(`${drift.length ? 'repo-defaults: drift' : 'repo-defaults: ok'} (${drift.length} item(s))`);
    process.stdout.write(`${L.join('\n')}\n`);
  }
  if (mode === 'check') return drift.length ? 1 : 0;
  if (mode === 'apply') return drift.length || failed.length ? 1 : 0;
  return 0;
}

// Run main() only when started directly. Both sides are resolved through links: run through a
// skill link (~/.claude/skills/<name> is a junction or symlink), argv[1] is the link path while
// import.meta.url is the real file.
function startedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) process.exitCode = main();
