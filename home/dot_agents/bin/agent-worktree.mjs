#!/usr/bin/env node
// agent-worktree: per-worktree setup and teardown for agent work (docs/lifecycle.md).
//
//   node agent-worktree.mjs <setup|teardown|sweep|status|gate|track|untrack> [options]
//
// Exit codes: 0 done (teardown: T3 may remove the worktree), 1 kept or failed (visible),
// 2 usage or configuration error. Output carries counts, ids and references, never secrets.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addResource, deleteLedger, listLedgers, readLedger, readRegistry, registerRepo,
  removeResource, updateLedger,
} from './lib/ledger.mjs';
import { captureToken, homeDir, opStatus, runOp, stripToken } from './lib/op.mjs';
import { envGet, git, gitOut, gh, ghJson, run, spawnDetached, splitArgv, which } from './lib/proc.mjs';
import { processesUnder, listProcesses, stopProcesses } from './lib/processes.mjs';
import {
  baseBranch, fnv1a, gitIdentity, isUnder, loadConfig, makeWtId, normPath, repoName,
  resolveContext, samePath, ticketOf,
} from './lib/repo.mjs';

const SELF = fileURLToPath(import.meta.url);
const NAME = 'agent-worktree';
const BEGIN = '# BEGIN agent-worktree';
const END = '# END agent-worktree';
const PR_FIELDS = 'number,state,headRefName,headRefOid,baseRefName,createdAt,url,body,labels';
export const QUEUE_LABELS = ['queued', 'landing', 'queue-blocked', 'queue-waiting'];

const USAGE = `usage: node agent-worktree.mjs <command> [options]
  setup                 prepare this worktree (ledger, ports, env file, repo setup steps)
  teardown              clean up after the PR merged or closed (exit 1 = keep)
  sweep                 finish leftovers: gone worktrees, merged branches, labelled containers
  status                list the ledgers
  gate                  run the repo's gate commands (--affected: the affected gate)
  track <kind> <id>     record a resource this worktree created [--where <host>]
  untrack <kind> <id>   forget a recorded resource
options: --dry-run --all --quick --json --repo <path> --where <host> --affected`;

// ---------------------------------------------------------------- output

let jsonMode = false;
function log(msg) { if (!jsonMode) process.stdout.write(`${NAME}: ${msg}\n`); }
function warn(msg) { process.stderr.write(`${NAME}: WARNING: ${msg}\n`); }
function firstLine(s) { return String(s || '').trim().split(/\r?\n/)[0].slice(0, 200); }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// ---------------------------------------------------------------- args

export function parseArgs(argv) {
  const opts = { _: [], dryRun: false, all: false, quick: false, json: false, affected: false, repo: null, where: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--quick') opts.quick = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--affected') opts.affected = true;
    else if (a === '--repo' || a === '--where') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

function startDir(opts) {
  return path.resolve(opts.repo || envGet(process.env, 'T3CODE_WORKTREE_PATH') || process.cwd());
}

function t3Root() {
  return path.resolve(envGet(process.env, 'AGENT_WORKTREE_T3_ROOT') || path.join(homeDir(), '.t3', 'worktrees'));
}

// ---------------------------------------------------------------- ports and env file

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function isPortFree(port) {
  return (await portFree(port, '127.0.0.1')) && (await portFree(port, '0.0.0.0'));
}

/** Stable ports: keep stored ones, else base + fnv1a(wtId+name) % 900, probed, unique in repo. */
export async function allocatePorts(cfgPorts, wtId, stored = {}, taken = new Set()) {
  const out = {};
  for (const [name, baseRaw] of Object.entries(cfgPorts || {})) {
    const base = Number(baseRaw);
    if (!Number.isInteger(base) || base < 1 || base > 65535 - 900) throw new Error(`ports.${name}: invalid base ${baseRaw}`);
    if (Number.isInteger(stored[name])) {
      out[name] = stored[name];
      taken.add(stored[name]);
      continue;
    }
    const start = fnv1a(wtId + name) % 900;
    let chosen = null;
    for (let i = 0; i < 900 && chosen === null; i++) {
      const p = base + ((start + i) % 900);
      if (!taken.has(p) && await isPortFree(p)) chosen = p;
    }
    if (chosen === null) throw new Error(`ports.${name}: no free port in ${base}-${base + 899}`);
    out[name] = chosen;
    taken.add(chosen);
  }
  return out;
}

/** Replace (or add) the managed footer in an env file; creates the file with mode 0600. */
export function writeFooter(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`(?:\\r?\\n)?${BEGIN}[^\\n]*\\n[\\s\\S]*?${END}[^\\n]*(?:\\r?\\n|$)`, 'g');
  text = text.replace(re, '\n');
  if (text && !text.endsWith('\n')) text += '\n';
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  text += `${BEGIN} (managed by setup; regenerated each run)\n${lines.join('\n')}\n${END}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

function envPaths(ctx, worktreePath = ctx.worktreePath) {
  const tpl = path.resolve(worktreePath, ctx.cfg.env.template || '.env.op');
  const out = path.resolve(worktreePath, ctx.cfg.env.output || '.env.local');
  if (!isUnder(out, worktreePath) || samePath(out, worktreePath)) throw new Error('env.output must be a file inside the worktree');
  return { tpl, out };
}

/** Number of op:// references that are not op://agent-repos/<repo>-<item>/<field>. */
export function foreignRefs(text, repo) {
  const refs = String(text).match(/op:\/\/[^\s"'`#]+/g) || [];
  const ok = new RegExp(`^op://agent-repos/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[^/]+/[^/]+`);
  return refs.filter((r) => !ok.test(r)).length;
}

function removeFile(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// ---------------------------------------------------------------- hooks

async function loadHooks(dir) {
  const file = path.join(dir, '.agents', 'hooks.mjs');
  if (!fs.existsSync(file)) return null;
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}

function hookCtx(ctx, ledger, { dryRun, worktreeGone }) {
  const cwd = worktreeGone ? ctx.repoRoot : ctx.worktreePath;
  return {
    repo: ctx.repo,
    repoRoot: ctx.repoRoot,
    worktreePath: ctx.worktreePath,
    wtId: ctx.wtId,
    branch: ctx.branch,
    ticket: ctx.ticket,
    ports: { ...(ledger.ports || {}) },
    dryRun: Boolean(dryRun),
    worktreeGone: Boolean(worktreeGone),
    track(kind, id, where) {
      if (dryRun) return log(`would track ${kind} ${id}`);
      updateLedger(ctx.commonDir, ctx.wtId, (l) => addResource(l, kind, id, where));
    },
    untrack(kind, id) {
      if (dryRun) return log(`would untrack ${kind} ${id}`);
      updateLedger(ctx.commonDir, ctx.wtId, (l) => removeResource(l, kind, id));
    },
    log(msg) { log(`[hook] ${msg}`); },
    run(argv, o = {}) {
      const a = splitArgv(argv);
      if (dryRun && !o.readOnly) {
        log(`[hook] would run: ${a[0]} (${a.length - 1} args)`);
        return { status: 0, stdout: '', stderr: '', dryRun: true };
      }
      return run(a[0], a.slice(1), { cwd: o.cwd || cwd, env: stripToken(o.env || process.env), input: o.input, inherit: o.inherit });
    },
  };
}

// ---------------------------------------------------------------- setup

async function cmdSetup(opts) {
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { log('not inside a git checkout: nothing to do'); return 0; }
  if (ctx.isMain) { log('main checkout: nothing to do'); return 0; }
  const { dryRun } = opts;
  const others = listLedgers(ctx.commonDir).filter((l) => l.wtId !== ctx.wtId && l.data.state !== 'torn-down');
  const taken = new Set(others.flatMap((l) => Object.values(l.data.ports || {})));
  const prev = readLedger(ctx.commonDir, ctx.wtId);
  const ports = await allocatePorts(ctx.cfg.ports, ctx.wtId, (prev && prev.ports) || {}, taken);
  const { tpl, out } = envPaths(ctx);

  if (dryRun) {
    log(`would set up ${ctx.wtId} (${plural(Object.keys(ports).length, 'port')}, ${plural(ctx.cfg.setup.length, 'setup step')}${fs.existsSync(tpl) ? ', env file from template' : ''})`);
    return 0;
  }

  updateLedger(ctx.commonDir, ctx.wtId, (l) => {
    Object.assign(l, {
      repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, branch: ctx.branch,
      ticket: ctx.ticket, ports, state: l.state === 'torn-down' ? 'active' : (l.state || 'active'),
    });
    return l;
  });
  try { registerRepo(ctx.repoRoot, ctx.repo); } catch (e) { warn(`repo registry not updated: ${e.message}`); }

  // Secrets: op inject into the env file, or no env file at all (never a stale one).
  let envNote = 'no env template';
  const badRefs = fs.existsSync(tpl) ? foreignRefs(fs.readFileSync(tpl, 'utf8'), ctx.repo) : 0;
  if (badRefs) {
    removeFile(out);
    warn('*****************************************************************');
    warn(`SECRETS NOT INJECTED: ${path.basename(tpl)} has ${plural(badRefs, 'reference')} outside op://agent-repos/${ctx.repo}-...`);
    warn('Only this repo\'s items in the agent-repos vault may be injected; fix the template.');
    warn('*****************************************************************');
    envNote = 'secrets NOT injected (template refused)';
  } else if (fs.existsSync(tpl)) {
    const st = opStatus();
    if (!st.op || !st.hasToken) {
      removeFile(out);
      warn('*****************************************************************');
      warn(`SECRETS NOT INJECTED: ${!st.op ? 'op (1Password CLI) not found' : 'no OP_SERVICE_ACCOUNT_TOKEN'}.`);
      warn(`${path.basename(out)} holds no secrets; fix op, then rerun setup.`);
      warn('*****************************************************************');
      envNote = 'secrets NOT injected';
    } else {
      const r = runOp(['inject', '-i', tpl, '-o', out, '--file-mode', '0600', '-f'], { cwd: ctx.worktreePath });
      if (r.status !== 0) {
        removeFile(out);
        warn(`op inject failed (exit ${r.status}): ${firstLine(r.stderr)}`);
        envNote = 'secrets NOT injected';
      } else envNote = 'secrets injected';
    }
  }
  const footer = { AGENT_WT_ID: ctx.wtId, ...ports };
  if (fs.existsSync(out) || Object.keys(ports).length) {
    writeFooter(out, footer);
    updateLedger(ctx.commonDir, ctx.wtId, (l) => addResource(l, 'env-file', out, 'local'));
  }

  // Repo setup steps: the only failure that fails setup.
  const env = { ...stripToken(process.env), ...Object.fromEntries(Object.entries(footer).map(([k, v]) => [k, String(v)])) };
  for (const step of ctx.cfg.setup) {
    let argv;
    try { argv = splitArgv(step); } catch (e) { warn(`setup step rejected: ${e.message}`); return 1; }
    log(`setup step: ${argv.join(' ')}`);
    const r = run(argv[0], argv.slice(1), { cwd: ctx.worktreePath, env, inherit: true });
    if (r.status !== 0) {
      warn(`setup step failed (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${argv[0]}`);
      return 1;
    }
  }

  const hooks = await loadHooks(ctx.worktreePath).catch((e) => { warn(`.agents/hooks.mjs failed to load: ${e.message}`); return null; });
  if (hooks && typeof hooks.setup === 'function') {
    const ledger = readLedger(ctx.commonDir, ctx.wtId);
    try { await hooks.setup(hookCtx(ctx, ledger, { dryRun: false })); } catch (e) { warn(`hooks.setup failed: ${e.message}`); }
  }

  const drift = path.join(homeDir(), '.agents', 'skills', 'repo-defaults', 'scripts', 'apply.mjs');
  if (fs.existsSync(drift)) {
    const r = run(process.execPath, [drift, '--check'], { cwd: ctx.worktreePath });
    if (r.status !== 0) warn('repo-defaults drift: run repo-defaults apply.mjs --check for details');
  }

  if (envGet(process.env, 'AGENT_WORKTREE_NO_SWEEP') !== '1') {
    try {
      spawnDetached(process.execPath, [SELF, 'sweep', '--quick', '--repo', ctx.repoRoot], { cwd: ctx.repoRoot });
    } catch (e) { warn(`background sweep not started: ${e.message}`); }
  }
  log(`setup done: ${ctx.wtId}, ${plural(Object.keys(ports).length, 'port')}, ${envNote}, ${plural(ctx.cfg.setup.length, 'setup step')}`);
  return 0;
}

// ---------------------------------------------------------------- PR state and the keep rules

function newest(prs) {
  return [...prs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

/** PRs for one head branch plus open PRs based on it. Throws when gh fails. */
function prsForBranch(dir, branch) {
  const head = ghJson(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '50', '--json', PR_FIELDS], { cwd: dir });
  const stacked = ghJson(['pr', 'list', '--base', branch, '--state', 'open', '--limit', '50', '--json', 'number'], { cwd: dir });
  return { head: head || [], stacked: stacked || [] };
}

/** Index of every PR in the repo by head and base branch (one gh call; for sweeps). */
function prIndex(dir) {
  const all = ghJson(['pr', 'list', '--state', 'all', '--limit', '1000', '--json', PR_FIELDS], { cwd: dir }) || [];
  const byHead = new Map();
  const openBase = new Map();
  for (const pr of all) {
    if (!byHead.has(pr.headRefName)) byHead.set(pr.headRefName, []);
    byHead.get(pr.headRefName).push(pr);
    if (pr.state === 'OPEN') {
      if (!openBase.has(pr.baseRefName)) openBase.set(pr.baseRefName, []);
      openBase.get(pr.baseRefName).push(pr);
    }
  }
  return {
    forBranch: (b) => ({ head: byHead.get(b) || [], stacked: openBase.get(b) || [] }),
  };
}

function labelNames(pr) {
  return (pr.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

/** Shas named by `Gate: pass @ <sha>` lines in a PR body. */
export function gatedShas(body) {
  return [...String(body || '').matchAll(/Gate:\s*pass\s*@\s*([0-9a-f]{7,40})\b/gi)].map((m) => m[1].toLowerCase());
}

/** True when `git range-diff prHead...tip` pairs every commit as identical (`=`). */
function samePatches(dir, prHead, tip) {
  if (!dir || !prHead || !tip) return false;
  if (git(['cat-file', '-e', `${prHead}^{commit}`], { cwd: dir }).status !== 0) return false;
  const r = git(['range-diff', '--no-color', `${prHead}...${tip}`], { cwd: dir });
  if (r.status !== 0) return false;
  const rows = r.stdout.split(/\r?\n/).filter((l) => /^\s*(-|\d+):\s+\S+\s+[<>=!]\s/.test(l));
  return rows.length > 0 && rows.every((l) => /^\s*\d+:\s+\S+\s+=\s/.test(l));
}

/**
 * The "pushed" predicate: tip equals the PR head, or a `Gate: pass @ <sha>` line in the PR
 * body names it, or nothing on it is outside the remotes, or range-diff shows the same
 * patches as the PR head. Returns null when pushed, else the reason.
 */
export function unpushedReason(dir, tip, pr) {
  if (!tip) return 'HEAD unknown';
  if (tip === pr.headRefOid) return null;
  if (gatedShas(pr.body).some((s) => tip.toLowerCase().startsWith(s))) return null;
  const ahead = gitOut(['rev-list', '--count', tip, '--not', '--remotes'], { cwd: dir });
  if (ahead !== null && Number(ahead) === 0) return null;
  if (samePatches(dir, pr.headRefOid, tip)) return null;
  return `${plural(Number(ahead || 0), 'commit')} not on any remote and HEAD differs from PR #${pr.number} head`;
}

/**
 * The teardown predicate. Returns {verdict, pr, detail} where verdict is one of
 * no-pr | open | queued | stacked | dirty | unpushed | eligible. Worktree checks run only
 * when worktreePath is given (it is gone for sweeps of removed worktrees).
 */
export function assess({ prs, worktreePath, ignore = [], tip }) {
  const pr = newest(prs.head);
  if (!pr) return { verdict: 'no-pr', pr: null, detail: 'no PR for this branch' };
  if (pr.state === 'OPEN' || prs.head.some((p) => p.state === 'OPEN')) {
    const open = prs.head.find((p) => p.state === 'OPEN') || pr;
    return { verdict: 'open', pr: open, detail: `PR #${open.number} is open` };
  }
  const inQueue = prs.head.find((p) => labelNames(p).some((n) => QUEUE_LABELS.includes(n)));
  if (inQueue) {
    return { verdict: 'queued', pr: inQueue, detail: `PR #${inQueue.number} is in the land queue (${labelNames(inQueue).filter((n) => QUEUE_LABELS.includes(n)).join(', ')})` };
  }
  if (prs.stacked.length) {
    return { verdict: 'stacked', pr, detail: `open PR ${prs.stacked.map((p) => `#${p.number}`).join(', ')} is based on this branch` };
  }
  const dir = worktreePath;
  if (dir) {
    const st = gitOut(['status', '--porcelain', '--untracked-files=all'], { cwd: dir });
    if (st === null) return { verdict: 'dirty', pr, detail: 'git status failed' };
    const skip = ignore.map((p) => normPath(p));
    const dirty = st.split(/\r?\n/).filter(Boolean).filter((line) => {
      const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
      return !skip.includes(normPath(path.resolve(dir, rel)));
    });
    if (dirty.length) return { verdict: 'dirty', pr, detail: `${plural(dirty.length, 'changed or untracked file')}` };
  }
  if (dir) {
    const why = unpushedReason(dir, tip || gitOut(['rev-parse', 'HEAD'], { cwd: dir }), pr);
    if (why) return { verdict: 'unpushed', pr, detail: why };
  }
  return { verdict: 'eligible', pr, detail: `PR #${pr.number} ${pr.state.toLowerCase()}` };
}

// ---------------------------------------------------------------- resource cleanup

function dockerCleanup(wtId, resources, dryRun) {
  const res = { containers: 0, volumes: 0, networks: 0, skipped: null, failed: 0 };
  if (!which('docker')) { res.skipped = 'docker not installed'; return res; }
  const ids = (kind, args) => {
    const r = run('docker', args);
    if (r.status !== 0) throw new Error(`docker ${kind} list failed (exit ${r.status})`);
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  };
  const tracked = (kind) => resources.filter((r) => r.kind === kind && r.where === 'local').map((r) => r.id);
  const label = `label=agent.wt=${wtId}`;
  try {
    const sets = [
      ['containers', ['ps', '-aq', '--filter', label], 'docker-container', ['rm', '-f']],
      ['volumes', ['volume', 'ls', '-q', '--filter', label], 'docker-volume', ['volume', 'rm', '-f']],
      ['networks', ['network', 'ls', '-q', '--filter', label], 'docker-network', ['network', 'rm']],
    ];
    for (const [key, listArgs, kind, rmArgs] of sets) {
      const all = [...new Set([...ids(key, listArgs), ...tracked(kind)])];
      if (!all.length) continue;
      if (dryRun) { res[key] = all.length; continue; }
      for (const id of all) {
        const r = run('docker', [...rmArgs, id]);
        if (r.status === 0 || /no such/i.test(r.stderr)) res[key]++;
        else res.failed++;
      }
    }
  } catch (e) {
    res.skipped = e.message;
  }
  return res;
}

function unsafeToDelete(p, ctx) {
  if (!path.isAbsolute(p)) return 'not absolute';
  const r = path.resolve(p);
  if (r === path.parse(r).root) return 'filesystem root';
  for (const guard of [homeDir(), ctx.repoRoot, ctx.commonDir]) {
    if (guard && isUnder(guard, r)) return 'contains a protected folder';
  }
  return null;
}

/**
 * Teardown of everything recorded for one worktree, after the predicate said eligible.
 * Returns a summary object; .errors lists anything that needs the owner.
 */
async function cleanup(ctx, ledger, pr, { dryRun, worktreeGone }) {
  const s = { processes: 0, docker: null, paths: 0, envFile: false, remoteBranch: false, hook: null, crReview: null, left: 0, errors: [] };
  const wt = ctx.worktreePath;

  if (!worktreeGone) {
    const procs = processesUnder(wt, listProcesses());
    if (dryRun) s.processes = procs.length;
    else if (procs.length) {
      const r = stopProcesses(procs);
      s.processes = r.stopped;
      if (r.failed) s.errors.push(`${plural(r.failed, 'process')} under the worktree could not be stopped`);
    }
  }

  const hooks = await loadHooks(worktreeGone ? ctx.repoRoot : wt).catch((e) => { s.errors.push(`hooks.mjs failed to load: ${e.message}`); return null; });
  if (hooks && typeof hooks.teardown === 'function') {
    try { await hooks.teardown(hookCtx(ctx, ledger, { dryRun, worktreeGone })); s.hook = 'ok'; } catch (e) { s.hook = 'failed'; s.errors.push(`hooks.teardown failed: ${e.message}`); }
  }

  if (which('cr-review')) {
    const key = ctx.ticket || ctx.wtId;
    if (dryRun) s.crReview = 'would run';
    else {
      const r = run('cr-review', ['--cleanup', key], { cwd: worktreeGone ? ctx.repoRoot : wt });
      s.crReview = r.status === 0 ? 'ok' : `exit ${r.status}`;
      if (r.status !== 0) warn(`cr-review --cleanup ${key} exited ${r.status}`);
    }
  }

  const fresh = (!dryRun && readLedger(ctx.commonDir, ctx.wtId)) || ledger;
  s.docker = dockerCleanup(ctx.wtId, fresh.resources, dryRun);
  if (s.docker.failed) s.errors.push(`${plural(s.docker.failed, 'docker object')} could not be removed`);

  const pathKinds = new Set(['file', 'dir', 'cache', 'path']);
  for (const r of fresh.resources) {
    if (!pathKinds.has(r.kind) || r.where !== 'local') continue;
    const why = unsafeToDelete(r.id, ctx);
    if (why) { s.errors.push(`refused to delete tracked ${r.kind} (${why})`); continue; }
    if (!fs.existsSync(r.id)) continue;
    if (dryRun) { s.paths++; continue; }
    try { fs.rmSync(r.id, { recursive: true, force: true }); s.paths++; } catch (e) { s.errors.push(`could not delete tracked ${r.kind}: ${e.code || e.message}`); }
  }

  if (!worktreeGone) {
    const { out } = envPaths(ctx);
    if (fs.existsSync(out)) s.envFile = dryRun ? 'would delete' : removeFile(out);
  }

  const pattern = ctx.cfg.remoteBranchDelete ? new RegExp(ctx.cfg.remoteBranchDelete) : null;
  if (pr && pr.state === 'MERGED' && ctx.branch && pattern && pattern.test(ctx.branch) && !ledger.remoteBranchDeleted) {
    if (dryRun) s.remoteBranch = 'would delete';
    else {
      const r = gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ctx.branch}`], { cwd: worktreeGone ? ctx.repoRoot : wt });
      if (r.status === 0 || /reference does not exist|not found|HTTP 404|HTTP 422/i.test(r.stderr + r.stdout)) s.remoteBranch = true;
      else warn(`remote branch not deleted (gh exit ${r.status}): ${firstLine(r.stderr)}`);
    }
  }

  const known = new Set([...pathKinds, 'env-file', 'docker-container', 'docker-volume', 'docker-network']);
  const after = (!dryRun && readLedger(ctx.commonDir, ctx.wtId)) || fresh;
  s.left = after.resources.filter((r) => !known.has(r.kind) || r.where !== 'local').length;
  return s;
}

function describe(s) {
  const d = s.docker || {};
  const parts = [
    plural(s.processes, 'process') + ' stopped',
    d.skipped ? `docker skipped (${d.skipped})` : `${plural(d.containers || 0, 'container')}, ${plural(d.volumes || 0, 'volume')}, ${plural(d.networks || 0, 'network')} removed`,
    `${plural(s.paths, 'tracked path')} deleted`,
    s.envFile ? 'env file deleted' : 'no env file',
  ];
  if (s.remoteBranch) parts.push('remote branch deleted');
  if (s.hook) parts.push(`hook ${s.hook}`);
  if (s.crReview) parts.push(`cr-review ${s.crReview}`);
  if (s.left) parts.push(`${plural(s.left, 'resource')} left to repo hooks`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- teardown

async function cmdTeardown(opts) {
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { log('not inside a git checkout: nothing to do'); return 0; }
  if (ctx.isMain) { log('main checkout: nothing to do'); return 0; }
  const { dryRun } = opts;
  const ledger = readLedger(ctx.commonDir, ctx.wtId) || { resources: [], ports: {} };
  const note = (state, keptReason, pr) => {
    if (dryRun) return;
    updateLedger(ctx.commonDir, ctx.wtId, (l) => Object.assign(l, {
      repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, branch: ctx.branch,
      ticket: ctx.ticket, state, keptReason, prNumber: pr ? pr.number : l.prNumber || null,
      prState: pr ? pr.state : l.prState || null,
    }));
  };
  if (!ctx.branch) { log('detached HEAD: nothing removed'); note('active', 'detached HEAD', null); return 0; }

  let prs;
  try { prs = prsForBranch(ctx.worktreePath, ctx.branch); } catch (e) {
    warn(`keep: cannot read PR state (${e.message}); nothing removed`);
    note('kept', 'PR state unknown', null);
    return 1;
  }
  const { out } = envPaths(ctx);
  const a = assess({ prs, worktreePath: ctx.worktreePath, ignore: [out] });
  if (a.verdict === 'no-pr' || a.verdict === 'open') {
    log(`${a.detail}: nothing removed`);
    note('active', a.detail, a.pr);
    return 0;
  }
  if (a.verdict !== 'eligible') {
    warn(`keep: ${a.detail}`);
    note('kept', a.detail, a.pr);
    return 1;
  }

  const s = await cleanup(ctx, ledger, a.pr, { dryRun, worktreeGone: false });
  if (dryRun) { log(`dry run, ${a.detail}: would do: ${describe(s)}`); return 0; }
  updateLedger(ctx.commonDir, ctx.wtId, (l) => Object.assign(l, {
    state: s.errors.length ? 'kept' : 'torn-down',
    keptReason: s.errors.length ? s.errors.join('; ') : null,
    prNumber: a.pr.number,
    prState: a.pr.state,
    remoteBranchDeleted: Boolean(l.remoteBranchDeleted || s.remoteBranch === true),
    tornDownAt: s.errors.length ? l.tornDownAt || null : new Date().toISOString(),
  }));
  if (s.errors.length) {
    for (const e of s.errors) warn(e);
    warn(`keep: teardown incomplete (${a.detail})`);
    return 1;
  }
  log(`teardown done, ${a.detail}: ${describe(s)}`);
  return 0;
}

// ---------------------------------------------------------------- sweep

function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)), branch: null, head: null, locked: false, prunable: false, bare: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === 'bare') cur.bare = true;
  }
  return out;
}

function repoContext(repoRoot, cfg, repo, commonDir, wt) {
  return {
    repo, repoRoot, commonDir, cfg, worktreePath: wt.worktreePath, branch: wt.branch,
    ticket: ticketOf(cfg, wt.branch), wtId: wt.wtId, isMain: false,
  };
}

async function sweepRepo(root, opts) {
  const { dryRun, quick } = opts;
  const id = gitIdentity(root);
  if (!id) return { repo: root, error: 'not a git checkout' };
  const repoRoot = id.repoRoot;
  const cfg = loadConfig(repoRoot);
  const repo = repoName(cfg, repoRoot);
  const base = baseBranch(cfg, repoRoot);
  const r = {
    repo, ledgersFinished: 0, ledgersRemoved: 0, worktreesRemoved: 0, branchesDeleted: 0,
    containersRemoved: 0, kept: [], errors: [],
  };
  if (!dryRun) git(['worktree', 'prune'], { cwd: repoRoot });

  let index = null;
  try { index = prIndex(repoRoot); } catch (e) { r.errors.push(`PR state unavailable (${e.message}): PR-dependent steps skipped`); }

  let worktrees = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repoRoot }));
  const live = new Set(worktrees.filter((w) => !w.prunable).map((w) => normPath(w.path)));

  // 1. Ledgers whose worktree is gone: finish their teardown, then forget them.
  for (const { wtId, data } of listLedgers(id.commonDir)) {
    const gone = !data.worktreePath || !live.has(normPath(data.worktreePath)) || !fs.existsSync(data.worktreePath);
    if (!gone) continue;
    if (data.state === 'torn-down') {
      if (!dryRun) deleteLedger(id.commonDir, wtId);
      r.ledgersRemoved++;
      continue;
    }
    if (!index) continue;
    const a = data.branch ? assess({ prs: index.forBranch(data.branch) }) : { verdict: 'no-pr', pr: null };
    if (['open', 'queued', 'stacked'].includes(a.verdict)) { r.kept.push(`${wtId}: ${a.detail}`); continue; }
    const ctx = repoContext(repoRoot, cfg, repo, id.commonDir, { worktreePath: data.worktreePath || repoRoot, branch: data.branch, wtId });
    const s = await cleanup(ctx, data, a.pr, { dryRun, worktreeGone: true });
    r.containersRemoved += s.docker && s.docker.containers ? s.docker.containers : 0;
    if (s.errors.length) { r.errors.push(`${wtId}: ${s.errors.join('; ')}`); continue; }
    r.ledgersFinished++;
    if (!dryRun) {
      updateLedger(id.commonDir, wtId, (l) => Object.assign(l, {
        state: 'torn-down', keptReason: null, tornDownAt: new Date().toISOString(),
        remoteBranchDeleted: Boolean(l.remoteBranchDeleted || s.remoteBranch === true),
        prNumber: a.pr ? a.pr.number : l.prNumber || null, prState: a.pr ? a.pr.state : l.prState || null,
      }));
    }
  }

  // 2. Hand-made worktrees outside the T3 root (T3 removes its own). Not in --quick.
  if (!quick && index) {
    const lander = normPath(`${repoRoot}-lander`);
    const t3 = t3Root();
    let procs = null;
    for (const w of worktrees) {
      if (samePath(w.path, repoRoot) || w.bare || w.locked || w.prunable || !w.branch) continue;
      if (normPath(w.path) === lander || isUnder(w.path, t3)) continue;
      if (!fs.existsSync(w.path)) continue;
      const wtId = makeWtId(repo, w.path);
      const ctx = repoContext(repoRoot, loadConfig(w.path), repo, id.commonDir, { worktreePath: w.path, branch: w.branch, wtId });
      const { out } = envPaths(ctx);
      const a = assess({ prs: index.forBranch(w.branch), worktreePath: w.path, ignore: [out] });
      if (a.verdict !== 'eligible') { r.kept.push(`${path.basename(w.path)}: ${a.detail}`); continue; }
      procs = procs || listProcesses();
      if (processesUnder(w.path, procs).length) { r.kept.push(`${path.basename(w.path)}: processes running inside`); continue; }
      const ledger = readLedger(id.commonDir, wtId) || { resources: [], ports: {} };
      const s = await cleanup(ctx, ledger, a.pr, { dryRun, worktreeGone: false });
      if (s.errors.length) { r.errors.push(`${path.basename(w.path)}: ${s.errors.join('; ')}`); continue; }
      if (dryRun) { r.worktreesRemoved++; continue; }
      const rm = git(['worktree', 'remove', w.path], { cwd: repoRoot });
      if (rm.status !== 0) { r.kept.push(`${path.basename(w.path)}: git worktree remove refused (${firstLine(rm.stderr)})`); continue; }
      r.worktreesRemoved++;
      if (readLedger(id.commonDir, wtId)) deleteLedger(id.commonDir, wtId);
    }
    if (!dryRun) worktrees = parseWorktrees(gitOut(['worktree', 'list', '--porcelain'], { cwd: repoRoot }));
  }

  // 3. Local branches whose PR merged or closed, with nothing unpushed.
  if (index) {
    const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
    const refs = (gitOut(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { cwd: repoRoot }) || '').split(/\r?\n/).filter(Boolean);
    for (const line of refs) {
      const [branch, tip] = line.split(' ');
      if (branch === base || branch === 'agent-landing-lock' || checkedOut.has(branch)) continue;
      const prs = index.forBranch(branch);
      if (!prs.head.length) continue;
      const a = assess({ prs, tip });
      if (a.verdict !== 'eligible') { r.kept.push(`branch ${branch}: ${a.detail}`); continue; }
      const why = unpushedReason(repoRoot, tip, a.pr);
      if (why) { r.kept.push(`branch ${branch}: ${why}`); continue; }
      if (!dryRun) {
        const d = git(['branch', '-D', branch], { cwd: repoRoot });
        if (d.status !== 0) { r.errors.push(`branch ${branch}: delete failed`); continue; }
      }
      r.branchesDeleted++;
    }
  }

  // 4. Labelled Docker leftovers of torn-down ledgers.
  for (const { wtId, data } of listLedgers(id.commonDir)) {
    if (data.state !== 'torn-down') continue;
    const d = dockerCleanup(wtId, [], dryRun);
    r.containersRemoved += d.containers || 0;
  }

  // 5. The repo's own sweep hook (repo-wide leftovers such as aged preview databases).
  const hooks = await loadHooks(repoRoot).catch((e) => { r.errors.push(`hooks.mjs failed to load: ${e.message}`); return null; });
  if (hooks && typeof hooks.sweep === 'function') {
    const ctx = repoContext(repoRoot, cfg, repo, id.commonDir, { worktreePath: repoRoot, branch: null, wtId: null });
    const hc = hookCtx(ctx, { ports: {} }, { dryRun, worktreeGone: false });
    hc.track = () => { throw new Error('track is per worktree; not available in sweep'); };
    hc.untrack = hc.track;
    hc.ledgers = listLedgers(id.commonDir).map(({ wtId, data }) => ({ wtId, branch: data.branch, state: data.state, worktreePath: data.worktreePath, resources: data.resources || [] }));
    try { await hooks.sweep(hc); r.hook = 'ok'; } catch (e) { r.errors.push(`hooks.sweep failed: ${e.message}`); }
  }
  return r;
}

function knownRepos(opts) {
  const roots = [];
  const add = (p) => { if (p && fs.existsSync(p) && !roots.some((x) => samePath(x, p))) roots.push(path.resolve(p)); };
  if (opts.all) for (const r of readRegistry().repos) add(r.root);
  const here = gitIdentity(startDir(opts));
  if (here) add(here.repoRoot);
  return roots;
}

async function cmdSweep(opts) {
  const roots = knownRepos(opts);
  const results = [];
  for (const root of roots) {
    try { results.push(await sweepRepo(root, opts)); } catch (e) { results.push({ repo: path.basename(root), errors: [e.message] }); }
  }
  if (opts.json) process.stdout.write(JSON.stringify({ dryRun: opts.dryRun, repos: results }, null, 2) + '\n');
  else {
    if (!roots.length) log('no repos to sweep');
    for (const r of results) {
      log(`sweep ${r.repo}${opts.dryRun ? ' (dry run)' : ''}: ${r.ledgersFinished || 0} finished, ${r.ledgersRemoved || 0} ledgers removed, ${r.worktreesRemoved || 0} worktrees removed, ${r.branchesDeleted || 0} branches deleted, ${r.containersRemoved || 0} containers removed, ${(r.kept || []).length} kept`);
      for (const k of r.kept || []) log(`  kept ${k}`);
      for (const e of r.errors || []) warn(`${r.repo}: ${e}`);
    }
  }
  return results.some((r) => (r.errors || []).length) ? 1 : 0;
}

// ---------------------------------------------------------------- status, gate, track

function cmdStatus(opts) {
  const rows = [];
  for (const root of knownRepos(opts)) {
    const id = gitIdentity(root);
    if (!id) continue;
    for (const { wtId, data } of listLedgers(id.commonDir)) {
      rows.push({
        repo: data.repo, wtId, branch: data.branch, state: data.state, pr: data.prNumber || null,
        prState: data.prState || null, resources: (data.resources || []).length, ports: data.ports || {},
        worktree: data.worktreePath && fs.existsSync(data.worktreePath) ? 'present' : 'gone',
        kept: data.keptReason || null,
      });
    }
  }
  if (opts.json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0; }
  if (!rows.length) { log('no ledgers'); return 0; }
  const cols = ['repo', 'wtId', 'branch', 'state', 'pr', 'resources', 'worktree', 'kept'];
  const cell = (r, c) => (c === 'pr' ? (r.pr ? `#${r.pr}${r.prState ? ` ${r.prState.toLowerCase()}` : ''}` : '-') : String(r[c] ?? '-'));
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd();
  process.stdout.write(`${line(cols)}\n`);
  for (const r of rows) process.stdout.write(`${line(cols.map((c) => cell(r, c)))}\n`);
  const states = rows.reduce((m, r) => ({ ...m, [r.state]: (m[r.state] || 0) + 1 }), {});
  process.stdout.write(`${plural(rows.length, 'ledger')}: ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
  return 0;
}

function cmdGate(opts) {
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { warn('not inside a git checkout'); return 2; }
  const steps = opts.affected ? ctx.cfg.affectedGate : ctx.cfg.gate;
  if (!steps.length) { warn(`no ${opts.affected ? 'affectedGate' : 'gate'} commands in .agents/repo.json`); return 2; }
  const ledger = readLedger(ctx.commonDir, ctx.wtId);
  const env = { ...stripToken(process.env), AGENT_WT_ID: ctx.wtId };
  for (const [k, v] of Object.entries((ledger && ledger.ports) || {})) env[k] = String(v);
  for (const step of steps) {
    let argv;
    try { argv = splitArgv(step); } catch (e) { warn(e.message); return 2; }
    log(`gate: ${argv.join(' ')}`);
    if (opts.dryRun) continue;
    const r = run(argv[0], argv.slice(1), { cwd: ctx.worktreePath, env, inherit: true });
    if (r.status !== 0) { warn(`gate failed (exit ${r.status}): ${argv.join(' ')}`); return r.status || 1; }
  }
  log(opts.dryRun ? `dry run: ${plural(steps.length, 'gate step')}` : `gate passed: ${plural(steps.length, 'step')}`);
  return 0;
}

function cmdTrack(opts, remove) {
  const [kind, id] = opts._.slice(1);
  if (!kind || !id) { warn(`usage: ${remove ? 'untrack' : 'track'} <kind> <id>${remove ? '' : ' [--where <host>]'}`); return 2; }
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { warn('not inside a git checkout'); return 2; }
  if (ctx.isMain) { warn('main checkout: resources are tracked per worktree'); return 2; }
  if (opts.dryRun) { log(`would ${remove ? 'untrack' : 'track'} ${kind} ${id}`); return 0; }
  updateLedger(ctx.commonDir, ctx.wtId, (l) => {
    if (!l.repo) Object.assign(l, { repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, branch: ctx.branch, ticket: ctx.ticket });
    return remove ? removeResource(l, kind, id) : addResource(l, kind, id, opts.where);
  });
  log(`${remove ? 'untracked' : 'tracked'} ${kind} ${id} for ${ctx.wtId}`);
  return 0;
}

// ---------------------------------------------------------------- main

export async function main(argv) {
  captureToken();
  let opts;
  try { opts = parseArgs(argv); } catch (e) { warn(e.message); process.stderr.write(`${USAGE}\n`); return 2; }
  jsonMode = opts.json;
  const cmd = opts._[0];
  if (opts.help || !cmd) { process.stdout.write(`${USAGE}\n`); return opts.help ? 0 : 2; }
  try {
    switch (cmd) {
      case 'setup': return await cmdSetup(opts);
      case 'teardown': return await cmdTeardown(opts);
      case 'sweep': return await cmdSweep(opts);
      case 'status': return cmdStatus(opts);
      case 'gate': return cmdGate(opts);
      case 'track': return cmdTrack(opts, false);
      case 'untrack': return cmdTrack(opts, true);
      default: warn(`unknown command ${cmd}`); process.stderr.write(`${USAGE}\n`); return 2;
    }
  } catch (e) {
    warn(`${cmd} failed: ${e.message}`);
    return cmd === 'teardown' ? 1 : 2;
  }
}

if (process.argv[1] && samePath(process.argv[1], SELF)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
