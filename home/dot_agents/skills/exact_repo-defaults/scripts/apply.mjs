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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const BLOCK_RE = /<!-- BEGIN agent-standard v(\d+)[^>]*-->[\s\S]*?<!-- END agent-standard -->/g;
const GITIGNORE_LINES = ['.env.local', '.env.local.pre-op'];
const TODO = 'TODO(repo-defaults)';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), status: r.status };
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
function withEol(text, eol) { return eol === '\n' ? text : text.replace(/\r?\n/g, eol); }
function asset(name) { return fs.readFileSync(path.join(ASSETS, name), 'utf8').replace(/\r\n/g, '\n'); }
function writeFile(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function json(text) { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; } }

export const BLOCK = asset('agents-block.md').trimEnd();
export const BLOCK_VERSION = Number(BLOCK.match(/agent-standard v(\d+)/)[1]);

// ------------------------------------------------------------------ items
// Each item returns { name, status: ok|missing|outdated|invalid|warn, detail, fix?: () => string }.
// missing/outdated/invalid are drift; fix() applies the change and returns what it did.

function agentsBlock(root) {
  const p = path.join(root, 'AGENTS.md');
  const text = readText(p);
  if (text === null) {
    return {
      name: 'AGENTS.md block', status: 'missing', detail: 'no AGENTS.md',
      fix: () => { writeFile(p, `${BLOCK}\n\n<!-- Repo-specific rules go below the block. Facts: docs/agents/repo.md and .agents/repo.json. -->\n`); return 'created AGENTS.md'; },
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
      fix: () => { fs.writeFileSync(p, `${withEol(BLOCK, eol)}${eol}${eol}${text}`); return 'inserted the block at the top of AGENTS.md'; },
    };
  }
  const current = blocks.length === 1 && blocks[0][0].replace(/\r\n/g, '\n') === BLOCK;
  if (current) return { name: 'AGENTS.md block', status: 'ok', detail: `agent-standard v${BLOCK_VERSION}` };
  const found = blocks.map((b) => `v${b[1]}`).join(', ');
  return {
    name: 'AGENTS.md block', status: 'outdated', detail: blocks.length > 1 ? `${blocks.length} blocks (${found})` : `${found}, want v${BLOCK_VERSION} text`,
    fix: () => {
      let first = true;
      const out = text.replace(BLOCK_RE, () => {
        if (!first) return '';
        first = false;
        return withEol(BLOCK, eol);
      }).replace(new RegExp(`(${eol}){3,}`, 'g'), `${eol}${eol}`);
      fs.writeFileSync(p, out);
      return `refreshed the block in AGENTS.md (was ${found})`;
    },
  };
}

function claudeMd(root) {
  const p = path.join(root, 'CLAUDE.md');
  let st = null;
  try { st = fs.lstatSync(p); } catch { st = null; }
  if (!st) return { name: 'CLAUDE.md', status: 'missing', detail: 'no CLAUDE.md', fix: () => { writeFile(p, '@AGENTS.md\n'); return 'created CLAUDE.md (@AGENTS.md)'; } };
  if (st.isSymbolicLink()) {
    const target = path.basename(fs.readlinkSync(p));
    return target === 'AGENTS.md' ? { name: 'CLAUDE.md', status: 'ok', detail: 'link to AGENTS.md' } : { name: 'CLAUDE.md', status: 'invalid', detail: `link to ${target}: fix by hand` };
  }
  const text = readText(p) ?? '';
  if (/^@AGENTS\.md\s*$/m.test(text)) return { name: 'CLAUDE.md', status: 'ok', detail: 'imports @AGENTS.md' };
  const eol = eolOf(text);
  return {
    name: 'CLAUDE.md', status: 'missing', detail: 'does not import @AGENTS.md',
    fix: () => { fs.writeFileSync(p, `@AGENTS.md${eol}${eol}${text}`); return 'prepended @AGENTS.md to CLAUDE.md'; },
  };
}

const isSetup = (s) => /agent-worktree\.mjs"?\s+setup\b/.test(s?.command || '');
const isTeardown = (s) => /agent-worktree\.mjs"?\s+teardown\b/.test(s?.command || '');

function t3Json(root) {
  const p = path.join(root, 't3.json');
  const want = JSON.parse(asset('t3.json'));
  const text = readText(p);
  if (text === null) return { name: 't3.json', status: 'missing', detail: 'no t3.json', fix: () => { writeFile(p, `${JSON.stringify(want, null, 2)}\n`); return 'created t3.json'; } };
  const parsed = json(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return { name: 't3.json', status: 'invalid', detail: 'does not parse: fix by hand' };
  const cur = parsed.value;
  const scripts = Array.isArray(cur.scripts) ? cur.scripts : [];
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
      const others = scripts.filter((s) => !isSetup(s) && !isTeardown(s)).map((s) => {
        // Only the first create/settle script runs: ours. Keep the others as manual scripts.
        const c = { ...s };
        if (c.runOnWorktreeCreate) c.runOnWorktreeCreate = false;
        if (c.runOnSettle) c.runOnSettle = false;
        delete c.async;
        return c;
      });
      const out = { ...cur, defaultThreadEnvMode: 'worktree', scripts: [...want.scripts, ...others] };
      fs.writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`);
      const demoted = scripts.filter((s) => !isSetup(s) && !isTeardown(s) && (s?.runOnWorktreeCreate || s?.runOnSettle)).length;
      return `updated t3.json${demoted ? ` (${demoted} other automatic script(s) made manual: move that work into .agents/repo.json setup or .agents/hooks.mjs)` : ''}`;
    },
  };
}

// ------------------------------------------------------------------ detection

export function detect(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pkg = json(readText(path.join(root, 'package.json')) ?? 'null').value || null;
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
  const text = readText(p);
  const d = detect(root);
  if (text === null) {
    return {
      name: '.agents/repo.json', status: 'missing', detail: 'no .agents/repo.json',
      fix: () => {
        writeFile(p, `${JSON.stringify(repoJsonFromDetection(d), null, 2)}\n`);
        return `created .agents/repo.json (${d.pm || 'no package manager'}, base ${d.base || 'main'}${d.gate ? '' : `, gate ${TODO}`})`;
      },
    };
  }
  const parsed = json(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return { name: '.agents/repo.json', status: 'invalid', detail: 'does not parse: fix by hand' };
  const cur = parsed.value;
  const tmpl = repoJsonFromDetection(d);
  const missing = Object.keys(tmpl).filter((k) => !(k in cur));
  const bad = [];
  if (cur.version !== 1) bad.push('version is not 1');
  if (cur.vault !== undefined && cur.vault !== 'agent-repos') bad.push('vault is not agent-repos');
  for (const k of ['setup', 'gate', 'affectedGate']) if (k in cur && !Array.isArray(cur[k])) bad.push(`${k} is not an array`);
  if (bad.length) return { name: '.agents/repo.json', status: 'invalid', detail: `${bad.join('; ')}: fix by hand` };
  if (missing.length) {
    return {
      name: '.agents/repo.json', status: 'outdated', detail: `missing keys: ${missing.join(', ')}`,
      fix: () => {
        const out = { ...cur };
        for (const k of missing) out[k] = tmpl[k];
        fs.writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`);
        return `added ${missing.length} key(s) to .agents/repo.json`;
      },
    };
  }
  return { name: '.agents/repo.json', status: 'ok', detail: 'v1' };
}

function gitignore(root) {
  const p = path.join(root, '.gitignore');
  const missing = GITIGNORE_LINES.filter((l) => !git(['check-ignore', '-q', '--no-index', l], root).ok);
  if (!missing.length) return { name: '.gitignore', status: 'ok', detail: GITIGNORE_LINES.join(', ') };
  return {
    name: '.gitignore', status: 'missing', detail: `not ignored: ${missing.join(', ')}`,
    fix: () => {
      const text = readText(p) ?? '';
      const eol = text ? eolOf(text) : '\n';
      const sep = text && !text.endsWith('\n') ? eol : '';
      fs.writeFileSync(p, `${text}${sep}${text ? eol : ''}# agent-standard: secrets injected from 1Password (repo-defaults)${eol}${missing.join(eol)}${eol}`);
      return `added ${missing.length} line(s) to .gitignore`;
    },
  };
}

function repoMd(root) {
  const p = path.join(root, 'docs', 'agents', 'repo.md');
  if (fs.existsSync(p)) return { name: 'docs/agents/repo.md', status: 'ok', detail: 'present' };
  return { name: 'docs/agents/repo.md', status: 'missing', detail: 'no repo facts page', fix: () => { writeFile(p, asset('repo.md')); return 'created docs/agents/repo.md'; } };
}

// ------------------------------------------------------------------ reports (never drift)

function todos(root) {
  const files = ['.agents/repo.json', 'docs/agents/repo.md'];
  let n = 0;
  const where = [];
  for (const f of files) {
    const c = (readText(path.join(root, f)) || '').split(TODO).length - 1;
    if (c) { n += c; where.push(`${f} (${c})`); }
  }
  return n ? { name: 'TODO markers', status: 'warn', detail: `${n} to fill in: ${where.join(', ')}` } : null;
}

function envFiles(root) {
  const out = [];
  const tracked = (f) => git(['ls-files', '--error-unmatch', f], root).ok;
  for (const f of fs.readdirSync(root)) {
    if (!/^\.env(\..+)?$/.test(f) || f === '.env.op' || !fs.statSync(path.join(root, f)).isFile()) continue;
    const keys = (readText(path.join(root, f)) || '').split(/\r?\n/).filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
    out.push({ file: f, keys, tracked: tracked(f) });
  }
  const op = readText(path.join(root, '.env.op'));
  const refs = op ? op.split(/\r?\n/).filter((l) => /=\s*["']?op:\/\//.test(l)) : [];
  const foreign = refs.filter((l) => !/op:\/\/agent-repos\//.test(l)).length;
  return { envOp: op === null ? null : { refs: refs.length, foreignVaultRefs: foreign }, files: out };
}

// Workflows that run on pull requests or the merge queue gate PRs; release/deploy ones do not.
function gatingWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readText(path.join(dir, f)) || '';
    // The `on:` block runs to the next top-level key (or the end of the file).
    const on = text.match(/^(on|"on"|'on'):[^\n]*\n?(?:[ \t#][^\n]*\n?|\n)*/m);
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
  const r = spawnSync('gh', ['api', `repos/${m[1]}/${m[2]}/rulesets`], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
  if (r.status !== 0) return { skipped: 'gh api failed (no gh, no access, or no network)' };
  const list = json(r.stdout).value || [];
  return { list: list.map((x) => ({ name: x.name, enforcement: x.enforcement, target: x.target })) };
}

// ------------------------------------------------------------------ main

export function evaluate(root, { offline = false } = {}) {
  const items = [agentsBlock(root), claudeMd(root), t3Json(root), repoJson(root), gitignore(root), repoMd(root)];
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

  let ev = evaluate(root, { offline });
  const actions = [];
  if (mode === 'apply') {
    for (const it of ev.items) if (DRIFT.has(it.status) && it.fix) actions.push(it.fix());
    ev = evaluate(root, { offline });
  }
  const drift = ev.items.filter((i) => DRIFT.has(i.status));
  const result = {
    mode, root, standard: `agent-standard v${BLOCK_VERSION}`, actions,
    items: ev.items.map(({ name, status, detail }) => ({ name, status, detail })),
    drift: drift.length, todo: ev.todo?.detail || null,
    detection: ev.detection, env: ev.env, gatingWorkflows: ev.workflows, rulesets: ev.rulesets,
  };
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const L = [];
    for (const a of actions) L.push(`APPLIED ${a}`);
    for (const i of result.items) L.push(`${i.status === 'ok' ? 'OK   ' : 'DRIFT'} ${i.name}: ${i.detail}`);
    if (ev.todo) L.push(`WARN  ${ev.todo.name}: ${ev.todo.detail}`);
    if (mode !== 'check') {
      for (const e of ev.env.files) L.push(`INFO  ${e.file}: ${e.keys} keys${e.tracked ? ' (TRACKED IN GIT: remove it and rotate)' : ''}; migrate with agent-secret import`);
      if (ev.env.envOp?.foreignVaultRefs) L.push(`WARN  .env.op: ${ev.env.envOp.foreignVaultRefs} reference(s) outside op://agent-repos/`);
      for (const w of ev.workflows) L.push(`INFO  PR-gating workflow ${w.file} (${w.triggers.join(', ')}): remove in a separate PR`);
      for (const r of ev.rulesets.list || []) L.push(`INFO  ruleset ${r.name} (${r.enforcement}): drop required checks and merge queue in the separate PR`);
      if (ev.rulesets.skipped) L.push(`INFO  rulesets not listed: ${ev.rulesets.skipped}`);
    }
    L.push(`${drift.length ? 'repo-defaults: drift' : 'repo-defaults: ok'} (${drift.length} item(s))`);
    process.stdout.write(`${L.join('\n')}\n`);
  }
  if (mode === 'check') return drift.length ? 1 : 0;
  if (mode === 'apply') return drift.length ? 1 : 0;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
