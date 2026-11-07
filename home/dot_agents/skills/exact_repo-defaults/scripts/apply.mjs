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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripToken } from '../../../bin/lib/op.mjs';
import { run } from '../../../bin/lib/proc.mjs';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const BLOCK_RE = /<!-- BEGIN agent-standard v(\d+)[^>]*-->[\s\S]*?<!-- END agent-standard -->/g;
const GITIGNORE_LINES = ['.env.local', '.env.local.pre-op'];
const TODO = 'TODO(repo-defaults)';

// The variables that point git at a particular repository (git rev-parse --local-env-vars,
// less the config ones). Inherited from an outer git (a hook), they would make every git call
// here act on that repository instead of --repo; other git settings are kept.
const GIT_REPO_VARS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE',
]);

function child(cmd, args, cwd, opts = {}) {
  const env = Object.fromEntries(Object.entries(stripToken(process.env)).filter(([k]) => !GIT_REPO_VARS.has(k.toUpperCase())));
  return run(cmd, args, { cwd, env, ...opts });
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
// A leading byte-order mark stays the file's first character on every write; checks read the
// text after it (a BOM before a fence or an import line would hide it).
function splitBom(text) { return text.startsWith('\uFEFF') ? ['\uFEFF', text.slice(1)] : ['', text]; }
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
  const tmp = `${target}.repo-defaults-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  replaceVia(tmp, target, text, mode, Boolean(st && st.nlink > 1));
}

// Write `text` to the new file `tmp` (created exclusively: an existing path there, such as a
// link a repo planted, makes this fail and is left alone), then move it over `target`: rename,
// or (several hard links) copy over it in place, which is the one non-atomic case. Only a temp
// file this call created is ever removed. Exported for tests.
export function replaceVia(tmp, target, text, mode, inPlace) {
  let created = false;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    created = true;
    // The umask can clear bits at creation (0664 becomes 0644 under 022): set the mode exactly.
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    if (inPlace) { fs.copyFileSync(tmp, target); fs.unlinkSync(tmp); } else fs.renameSync(tmp, target);
  } catch (e) {
    if (created) { try { fs.unlinkSync(tmp); } catch { /* already moved or gone */ } }
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
    // bigint ids: Windows file ids can exceed 2^53 and would round as numbers.
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
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
  // A BEGIN inside a match means an END is missing: the match would swallow repo text up to a
  // later block's END. Report it; never replace it.
  if (blocks.some((b) => b[0].slice(1).includes('<!-- BEGIN agent-standard'))) {
    return { name: 'AGENTS.md block', status: 'invalid', detail: 'a BEGIN marker without its END before the next block: fix by hand' };
  }
  // Every BEGIN must belong to one complete block (an unmatched BEGIN after a block, too).
  const begins = (text.match(/<!-- BEGIN agent-standard/g) || []).length;
  if (blocks.length && begins !== blocks.length) {
    return { name: 'AGENTS.md block', status: 'invalid', detail: `${begins} BEGIN markers but ${blocks.length} complete block(s): fix by hand` };
  }
  if (/<!-- BEGIN agent-standard/.test(text) && !blocks.length) {
    return { name: 'AGENTS.md block', status: 'invalid', detail: 'BEGIN marker without END: fix by hand' };
  }
  if (!blocks.length) {
    return {
      name: 'AGENTS.md block', status: 'missing', detail: 'no managed block',
      fix: () => { const [bom, body] = splitBom(text); writeIn(root, p, `${bom}${withEol(BLOCK, eol)}${eol}${eol}${body}`); return 'inserted the block at the top of AGENTS.md'; },
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
  const [bom, body] = splitBom(text);
  if (importsAgents(body)) return { name: 'CLAUDE.md', status: 'ok', detail: 'imports @AGENTS.md' };
  const eol = eolOf(text);
  return {
    name: 'CLAUDE.md', status: 'missing', detail: 'does not import @AGENTS.md',
    fix: () => { writeIn(root, p, `${bom}@AGENTS.md${eol}${eol}${body}`); return 'prepended @AGENTS.md to CLAUDE.md'; },
  };
}

// Claude Code imports `@path` anywhere in the text, relative to the file (so `@./AGENTS.md` is
// the same file); the path ends at the first space; code spans and fenced code blocks are
// skipped (code.claude.com/docs/en/memory, "Import additional files"). The token must stand
// alone: `@AGENTS.md-old`, `@AGENTS.md.` or `(@AGENTS.md)` name other paths.
function importsAgents(text) {
  // A code span can run over lines, but never past a blank line (the end of a paragraph).
  const prose = outsideFences(text).split(/\n[ \t]*\n/)
    .map((para) => para.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ')).join('\n\n');
  return /(?:^|\s)@(?:\.\/)?AGENTS\.md(?=\s|$)/m.test(prose);
}

// The text outside fenced code blocks (``` or ~~~, closed by the same character, at least as
// long): Claude Code does not expand an @import written inside one.
function outsideFences(text) {
  const out = [];
  let fence = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m.index + m[0].length).trim()) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return out.join('\n');
}

// An engine script: `node "<path>/agent-worktree.mjs" <cmd>`, or the shell-neutral launcher in
// assets/t3.json (`node -e "...'agent-worktree.mjs')...;import(...)" <cmd>`), which finds the
// engine through os.homedir() because T3 may run project scripts in cmd.exe, PowerShell or sh,
// and cmd.exe does not expand $HOME.
const engineCall = (word) => new RegExp(`agent-worktree\\.mjs(?:"?|'\\)[^"]*")\\s+${word}\\b`);
const isSetup = (s) => engineCall('setup').test(s?.command || '');
const isTeardown = (s) => engineCall('teardown').test(s?.command || '');
// The earlier canonical commands: `$HOME` is not expanded by cmd.exe, so they fail on Windows.
const LEGACY_COMMANDS = ['setup', 'teardown'].map((w) => `node "$HOME/.agents/bin/agent-worktree.mjs" ${w}`);

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
  if ([setupIdx, tdIdx].some((i) => i >= 0 && LEGACY_COMMANDS.includes(norm(scripts[i].command)))) {
    problems.push('engine scripts use $HOME, which cmd.exe does not expand (Windows)');
  }
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
  // An exact copy of a current or an earlier (legacy $HOME) engine script.
  return JSON.parse(asset('t3.json')).scripts.some((w, i) => [norm(w.command), LEGACY_COMMANDS[i]].includes(norm(s?.command))
    && Object.keys(s).every((k) => Object.hasOwn(w, k)));
}

// ------------------------------------------------------------------ detection

// Yarn 1 enforces the lockfile with --frozen-lockfile, Yarn 2+ with --immutable (Yarn 1 ignores
// it). The version comes from the repo's own metadata, never by running yarn: package.json
// packageManager, then the lockfile's format (v1 header, or Berry's __metadata), then
// .yarnrc.yml (Berry only). Unknown: a TODO, not a guess.
function yarnInstall(root, pkg) {
  const pmField = typeof pkg?.packageManager === 'string' ? pkg.packageManager.match(/^yarn@(\d+)\./) : null;
  let major = pmField ? Number(pmField[1]) : null;
  if (major === null) {
    const head = (readText(path.join(root, 'yarn.lock'), root) || '').slice(0, 4096);
    if (/^# yarn lockfile v1\b/m.test(head)) major = 1;
    else if (/^__metadata:/m.test(head)) major = 2;
    else if (fs.existsSync(path.join(root, '.yarnrc.yml'))) major = 2;
  }
  if (major === null) return `${TODO}: yarn install command (yarn install --frozen-lockfile for Yarn 1, --immutable for Yarn 2+)`;
  return major === 1 ? 'yarn install --frozen-lockfile' : 'yarn install --immutable';
}

export function detect(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pkg = json(readText(path.join(root, 'package.json'), root) ?? 'null').value || null;
  let pm = null;
  let install = null;
  if (has('pnpm-lock.yaml')) { pm = 'pnpm'; install = 'pnpm install --frozen-lockfile'; }
  else if (has('bun.lock') || has('bun.lockb')) { pm = 'bun'; install = 'bun install --frozen-lockfile'; }
  else if (has('yarn.lock')) { pm = 'yarn'; install = yarnInstall(root, pkg); }
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
        // A missing itemPrefix defaults to the repo's own `repo` (the engine's default too), not
        // the name detected from origin: existing .env.op references keep their prefix.
        for (const k of missing) out[k] = k === 'itemPrefix' && typeof cur.repo === 'string' && cur.repo ? cur.repo : tmpl[k];
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
  // Git does not read a .gitignore that is a symbolic link: lines written through it would
  // never take effect (and would be added again on every run). Fixed by hand.
  let st = null;
  try { st = fs.lstatSync(p); } catch { st = null; }
  if (st?.isSymbolicLink()) return { name: '.gitignore', status: 'invalid', detail: 'a symbolic link, which Git does not read: replace it with a file by hand' };
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

const NESTED_ENV_CAP = 200;

// An env file's key count, or why it was not read: a link that leaves the repo is never followed
// (outside), and one that cannot be read is unreadable; both need a check by hand. No values.
function envRead(p, root) {
  try { inside(root, p); } catch { return { keys: null, outside: true }; }
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { keys: null, unreadable: true }; }
  return { keys: text.split(/\r?\n/).filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length };
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
    out.push({ file: f, ...envRead(p, root), tracked: tracked(f), role: envRole(f) });
  }
  // A tracked root env file deleted from the checkout is still in git history: listed too.
  const rootTracked = git(['ls-files', '-z', '--', '.env', '.env.*'], root);
  if (rootTracked.ok) {
    for (const f of rootTracked.out.split('\0').filter(Boolean)) {
      if (f.includes('/') || !/^\.env(\..+)?$/.test(f) || f === '.env.op' || out.some((e) => e.file === f)) continue;
      let present = true;
      try { fs.lstatSync(path.join(root, f)); } catch { present = false; }
      if (!present) out.push({ file: f, keys: 0, tracked: true, role: envRole(f), missing: true });
    }
  }
  // Tracked env files below the root are exposed in git history too: listed for rotation.
  // Only what git tracks (no walk of the tree, untracked files or caches), read through the same
  // containment checks; key counts only, never values.
  const nested = git(['ls-files', '-z', '--', '*/.env', '*/.env.*'], root);
  let nestedIncomplete = null;
  if (nested.ok) {
    const names = nested.out.split('\0').filter(Boolean).filter((f) => {
      const base = f.split('/').pop();
      return /^\.env(\..+)?$/.test(base) && base !== '.env.op';
    });
    if (names.length > NESTED_ENV_CAP) nestedIncomplete = { listed: NESTED_ENV_CAP, total: names.length };
    for (const f of names.slice(0, NESTED_ENV_CAP)) {
      const base = f.split('/').pop();
      const p = path.join(root, ...f.split('/'));
      let st;
      try { st = fs.lstatSync(p); } catch { out.push({ file: f, keys: 0, tracked: true, role: envRole(base), missing: true }); continue; }
      if (st.isSymbolicLink()) {
        try { st = fs.statSync(p); } catch { out.push({ file: f, keys: 0, tracked: true, role: envRole(base), dangling: true }); continue; }
      }
      if (!st.isFile()) continue;
      out.push({ file: f, ...envRead(p, root), tracked: true, role: envRole(base) });
    }
  }
  const op = readText(path.join(root, '.env.op'), root);
  const refs = op ? op.split(/\r?\n/).filter((l) => /=\s*["']?op:\/\//.test(l)) : [];
  const foreign = refs.filter((l) => !/op:\/\/agent-repos\//.test(l)).length;
  // `.env.op` must be committed. A broad rule (for example `.env*`) would make a new one
  // silently left out of `git add`; a tracked one is committed whatever the rules say.
  const envOpIgnored = !tracked('.env.op') && git(['check-ignore', '-q', '--no-index', '--', '.env.op'], root).ok;
  return { envOp: op === null ? null : { refs: refs.length, foreignVaultRefs: foreign }, envOpIgnored, files: out, nestedIncomplete };
}

// Workflows that run on pull requests or the merge queue gate PRs; release/deploy ones do not.
// A folder that cannot be listed (a file, no permission) is reported as { error }, so it never
// stops the report or loses the actions already applied.
function gatingWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { error: `.github/workflows could not be listed (${e.code || e.message})` }; }
  const out = [];
  for (const f of names.filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readText(path.join(dir, f), root);
    // One that cannot be read (a folder, no permission, a link out of the repo) might gate PRs.
    if (text === null) { out.push({ file: `.github/workflows/${f}`, triggers: [], unreadable: true }); continue; }
    // The `on:` block runs to the next top-level key (or the end of the file).
    const on = text.match(/^(on|"on"|'on'):[^\n]*\n?(?:[ \t#][^\n]*\n?|\r?\n)*/m);
    const section = on ? on[0] : text;
    const triggers = ['pull_request_target', 'pull_request', 'merge_group'].filter((t) => new RegExp(`\\b${t}\\b`).test(section));
    if (triggers.length) out.push({ file: `.github/workflows/${f}`, triggers });
  }
  return out;
}

// The rules that gate PRs on CI; every other rule (deletion, force-push, reviews) stays.
const GATING_RULES = new Set(['required_status_checks', 'merge_queue']);
const RULESET_PAGE = 100;
const RULESET_MAX_PAGES = 20;

// Every ruleset (all pages), each read in full: only those with a gating rule are listed, with
// those rules. One whose rules cannot be read is reported as unreadable, never as non-gating; a
// list page that cannot be read makes the report incomplete.
function rulesets(root, offline) {
  if (offline) return { skipped: 'offline' };
  const remote = git(['remote', 'get-url', 'origin'], root);
  const m = remote.ok ? remote.out.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i) : null;
  if (!m) return { skipped: 'origin is not on GitHub' };
  const route = `repos/${m[1]}/${m[2]}/rulesets`;
  const api = (r, params = []) => {
    const c = child('gh', ['api', '--method', 'GET', r, ...params.flatMap((x) => ['-f', x])], root, { timeout: 30000 });
    return c.status === 0 ? json(c.stdout).value : undefined;
  };
  const all = [];
  let incomplete = null;
  for (let page = 1; ; page++) {
    if (page > RULESET_MAX_PAGES) { incomplete = `more than ${RULESET_MAX_PAGES * RULESET_PAGE} rulesets; only the first ${all.length} were checked`; break; }
    const v = api(route, [`per_page=${RULESET_PAGE}`, `page=${page}`]);
    if (!Array.isArray(v)) {
      if (page === 1) return { skipped: 'gh api failed (no gh, no access, or no network)' };
      incomplete = `page ${page} of the ruleset list could not be read; only the first ${all.length} were checked`;
      break;
    }
    all.push(...v.filter((x) => x && typeof x === 'object'));
    if (v.length < RULESET_PAGE) break;
  }
  const list = [];
  const unreadable = [];
  for (const x of all) {
    const d = Number.isSafeInteger(x.id) ? api(`${route}/${x.id}`) : undefined;
    if (!d || typeof d !== 'object' || !Array.isArray(d.rules)) { unreadable.push({ name: x.name, id: x.id ?? null }); continue; }
    const gating = [...new Set(d.rules.map((r) => r?.type).filter((t) => GATING_RULES.has(t)))];
    if (gating.length) list.push({ name: x.name, enforcement: x.enforcement, target: x.target, rules: gating });
  }
  return { list, unreadable, incomplete };
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
  // Anything else (`check`, `-check`, a stray word) is a mistake, not a request to inspect: only
  // the path after --repo may stand alone.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') { i++; continue; }
    if (!argv[i].startsWith('--')) { process.stderr.write(`unexpected argument ${argv[i]} (options start with --)\n`); return 2; }
  }
  if (flags.has('--help')) { process.stdout.write('usage: node apply.mjs [--inspect|--check|--apply] [--repo <path>] [--json] [--offline]\n'); return 0; }
  // One mode at most, and --repo needs a path: a wrong call stops here, before any write.
  const modes = ['--inspect', '--check', '--apply'].filter((m) => flags.has(m));
  if (modes.length > 1) { process.stderr.write(`choose one of ${modes.join(', ')}\n`); return 2; }
  const mode = flags.has('--apply') ? 'apply' : flags.has('--check') ? 'check' : 'inspect';
  const ri = argv.indexOf('--repo');
  if (ri >= 0 && (argv[ri + 1] === undefined || argv[ri + 1].startsWith('--'))) { process.stderr.write('--repo needs a path\n'); return 2; }
  const start = ri >= 0 ? path.resolve(argv[ri + 1]) : process.cwd();
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
    detection: ev.detection, env: ev.env, gatingWorkflows: Array.isArray(ev.workflows) ? ev.workflows : [],
    gatingWorkflowsError: Array.isArray(ev.workflows) ? null : ev.workflows.error, rulesets: ev.rulesets,
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
        else if (e.outside) L.push(`WARN  ${e.file}: a link that leaves the repo, so it was not read${tracked}; check it by hand`);
        else if (e.unreadable) L.push(`WARN  ${e.file}: could not be read${tracked}; check it by hand`);
        else if (e.missing) L.push(`WARN  ${e.file}: tracked in git but not in the checkout (still in history: rotate its values)`);
        else if (e.role === 'source') L.push(`INFO  ${e.file}: ${e.keys} keys${tracked}; migrate with agent-secret import`);
        else L.push(`INFO  ${e.file}: ${e.role}, ${e.keys} keys${tracked}`);
      }
      if (ev.env.nestedIncomplete) L.push(`WARN  tracked env files below the root: only ${ev.env.nestedIncomplete.listed} of ${ev.env.nestedIncomplete.total} listed; list the rest with git ls-files and check them for rotation`);
      if (ev.env.envOp?.foreignVaultRefs) L.push(`WARN  .env.op: ${ev.env.envOp.foreignVaultRefs} reference(s) outside op://agent-repos/`);
      for (const w of result.gatingWorkflows) {
        if (w.unreadable) L.push(`WARN  workflow ${w.file} could not be read: check by hand whether it runs on pull_request or merge_group`);
        else L.push(`INFO  PR-gating workflow ${w.file} (${w.triggers.join(', ')}): remove in a separate PR`);
      }
      if (result.gatingWorkflowsError) L.push(`WARN  ${result.gatingWorkflowsError}: PR-gating workflows not checked`);
      for (const r of ev.rulesets.list || []) L.push(`INFO  ruleset ${r.name} (${r.enforcement}) has ${r.rules.join(', ')}: drop only those rules in the separate PR, keep its other rules`);
      for (const r of ev.rulesets.unreadable || []) L.push(`WARN  ruleset ${r.name}: its rules could not be read; check by hand for required status checks or a merge queue`);
      if (ev.rulesets.incomplete) L.push(`WARN  rulesets: ${ev.rulesets.incomplete}`);
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
