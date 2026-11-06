#!/usr/bin/env node
// agent-worktree: per-worktree setup and teardown for agent work (docs/lifecycle.md).
//
//   node agent-worktree.mjs <setup|teardown|sweep|status|gate|track|untrack> [options]
//
// Exit codes: 0 done (teardown: T3 may remove the worktree), 1 kept or failed (visible),
// 2 usage or configuration error. Output carries counts, ids and references, never secrets.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addResource, deleteLedger, isPathKind, ledgerDir, listLedgers, normalizeTrack, readLedger,
  readRegistry, registerRepo, removeResource, tryLock, updateLedger, withLockAsync,
} from './lib/ledger.mjs';
import { captureToken, homeDir, opStatus, runOp, stripToken } from './lib/op.mjs';
import { envGet, git, gitOut, gh, run, spawnDetached, splitArgv, which } from './lib/proc.mjs';
import { listProcesses, processesUnder, stopProcesses } from './lib/processes.mjs';
import {
  baseBranch, canonical, canonKey, fnv1a, gitIdentity, isUnder, loadConfig, makeWtId, normPath,
  repoName, resolveContext, samePath, ticketOf,
} from './lib/repo.mjs';

const SELF = fileURLToPath(import.meta.url);
const HOOK_RUNNER = path.join(path.dirname(SELF), 'lib', 'hook-runner.mjs');
const NAME = 'agent-worktree';
const BEGIN = '# BEGIN agent-worktree';
const END = '# END agent-worktree';
const PR_FIELDS = 'number,state,headRefName,headRefOid,baseRefName,createdAt,url,body,labels';
export const QUEUE_LABELS = ['queued', 'landing', 'queue-blocked', 'queue-waiting', 'queue-hold'];
const DOCKER_ID = /^[A-Za-z0-9][\w.-]*$/;

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
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`; }

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

function prLimit() {
  const n = Number(envGet(process.env, 'AGENT_WORKTREE_PR_LIMIT'));
  return Number.isInteger(n) && n > 0 ? n : 1000;
}

// ---------------------------------------------------------------- gh (with the repo's wrapper)

function ghRun(cfg, args, opts = {}) {
  if (cfg && cfg.ghWrapper) {
    const w = splitArgv(cfg.ghWrapper);
    return run(w[0], [...w.slice(1), ...args], opts);
  }
  return gh(args, opts);
}

function ghJsonC(cfg, args, opts = {}) {
  const r = ghRun(cfg, args, opts);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
  try { return JSON.parse(r.stdout || 'null'); } catch { throw new Error(`gh ${args.slice(0, 2).join(' ')}: output is not JSON`); }
}

// ---------------------------------------------------------------- ports and env file

/** Try to bind host:port. Resolves null when it binds, else the error code. */
function tryBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code || 'ERROR'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(null)));
  });
}

const PROBE_HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::'];
// An address family this machine lacks says nothing about the port.
const NO_FAMILY = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT']);

/** Free for a new allocation: every loopback and wildcard address, IPv4 and IPv6, binds. */
async function isPortFree(port) {
  for (const h of PROBE_HOSTS) {
    const code = await tryBind(port, h);
    if (code && !NO_FAMILY.has(code)) return false;
  }
  return true;
}

/** Some process holds the port (IPv4 or IPv6, loopback or wildcard). */
async function portInUse(port) {
  for (const h of PROBE_HOSTS) {
    // Windows reports a port held with exclusive use as EACCES.
    if (['EADDRINUSE', 'EACCES'].includes(await tryBind(port, h))) return true;
  }
  return false;
}

/** Stable ports: keep stored ones, else base + fnv1a(wtId+name) % 900, probed, unique in repo. */
export async function allocatePorts(cfgPorts, wtId, stored = {}, taken = new Set()) {
  const out = {};
  for (const [name, baseRaw] of Object.entries(cfgPorts || {})) {
    const base = Number(baseRaw);
    if (!Number.isInteger(base) || base < 1 || base > 65535 - 900) throw new Error(`ports.${name}: invalid base ${baseRaw}`);
    // A stored port is kept unless another live ledger now holds it.
    if (Number.isInteger(stored[name]) && !taken.has(stored[name])) {
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

/** Number of op:// references that are not op://agent-repos/<prefix>-<item>/<field>. */
export function foreignRefs(text, prefix) {
  // 1Password references are case-insensitive: OP://Other-Vault/... is a reference too.
  const refs = String(text).match(/op:\/\/[^\s"'`#]+/gi) || [];
  const ok = new RegExp(`^op://agent-repos/${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[^/]+/[^/]+`, 'i');
  return refs.filter((r) => !ok.test(r)).length;
}

function itemPrefix(ctx) { return String(ctx.cfg.itemPrefix || ctx.repo).toLowerCase(); }

function envPaths(ctx, worktreePath = ctx.worktreePath) {
  const tpl = path.resolve(worktreePath, ctx.cfg.env.template || '.env.op');
  const out = path.resolve(worktreePath, ctx.cfg.env.output || '.env.local');
  if (!isUnder(out, worktreePath) || samePath(out, worktreePath)) throw new Error('env.output must be a file inside the worktree');
  return { tpl, out };
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function isTracked(dir, file) {
  return git(['ls-files', '--error-unmatch', '--', file], { cwd: dir }).status === 0;
}

/**
 * True when a folder between dir and file is a link or junction, or the file's folder does not
 * resolve inside dir: writing or deleting there would land somewhere else.
 */
function linkedAncestor(dir, file) {
  const root = path.resolve(dir);
  let cur = path.dirname(path.resolve(file));
  while (isUnder(cur, root) && !samePath(cur, root)) {
    if (isSymlink(cur)) return true;
    cur = path.dirname(cur);
  }
  return !isUnder(canonical(path.dirname(path.resolve(file))), canonical(root));
}

/** Why the env output file is unsafe to write secrets into, or null. */
function envOutputProblem(dir, out) {
  if (linkedAncestor(dir, out)) return 'has a linked folder in its path';
  if (isSymlink(out)) return 'is a symlink or junction';
  if (isTracked(dir, out)) return 'is tracked by git';
  if (git(['check-ignore', '-q', '--', out], { cwd: dir }).status !== 0) return 'is not git-ignored';
  return null;
}

/**
 * The env output to leave out of the dirty check (dirtyCount skips it only as an untracked
 * `??` entry, so staged or tracked changes to it still count).
 */
function envIgnore(dir, out) {
  return linkedAncestor(dir, out) ? [] : [out];
}

/** True when setup wrote this env output (its managed block, or the ledger records it). */
function managedOutput(ctx, out) {
  try { if (fs.readFileSync(out, 'utf8').includes(BEGIN)) return true; } catch { return false; }
  const l = readLedger(ctx.commonDir, ctx.wtId);
  return Boolean(l && (l.resources || []).some((r) => r.kind === 'env-file' && samePath(r.id, out)));
}

function removeFile(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function loud(lines) {
  warn('*****************************************************************');
  for (const l of lines) warn(l);
  warn('*****************************************************************');
}

// ---------------------------------------------------------------- hooks (in a child process)

/**
 * Run hooks.<fn>(ctx) from <dir>/.agents/hooks.mjs in a separate node process whose
 * environment has no 1Password token. Returns null (no hook), 'ok', or throws on failure.
 */
function runHook(fn, dir, data, commonDir) {
  const hookFile = path.join(dir, '.agents', 'hooks.mjs');
  if (!fs.existsSync(hookFile)) return null;
  const cwd = fs.existsSync(data.worktreePath || '') && !data.worktreeGone ? data.worktreePath : data.repoRoot;
  // The runner writes "absent" (no such function) or "done" (the hook returned) to a result
  // file: no exit code a hook can produce is mistaken for either, and a hook that exits early,
  // even with 0, has not finished.
  const resultFile = path.join(os.tmpdir(), `agent-hook-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  let r;
  let result = '';
  try {
    r = run(process.execPath, [HOOK_RUNNER], {
      cwd, env: stripToken(process.env), input: JSON.stringify({ hookFile, fn, ctx: data, commonDir, resultFile }), inherit: true,
      stdoutToStderr: Boolean(jsonMode),
    });
    try { result = fs.readFileSync(resultFile, 'utf8'); } catch { /* none written */ }
  } finally { removeFile(resultFile); }
  if (result === 'absent') return null;
  if (r.status !== 0) throw new Error(`hooks.${fn} failed (exit ${r.status})`);
  if (result !== 'done') throw new Error(`hooks.${fn} exited before it finished`);
  return 'ok';
}

function hookData(ctx, ledger, { dryRun, worktreeGone }) {
  return {
    repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, wtId: ctx.wtId,
    branch: ctx.branch, ticket: ctx.ticket, ports: { ...((ledger && ledger.ports) || {}) },
    dryRun: Boolean(dryRun), worktreeGone: Boolean(worktreeGone),
  };
}

/** Refuse when this wtId's ledger records another worktree that still exists. */
function identityConflict(ctx) {
  const l = readLedger(ctx.commonDir, ctx.wtId);
  if (!l || !l.worktreePath || canonKey(l.worktreePath) === canonKey(ctx.worktreePath)) return null;
  if (!fs.existsSync(l.worktreePath)) return null;
  return `ledger ${ctx.wtId} belongs to another worktree (${path.basename(l.worktreePath)}); nothing changed`;
}

// ---------------------------------------------------------------- setup

async function cmdSetup(opts) {
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { log('not inside a git checkout: nothing to do'); return 0; }
  if (ctx.isMain) { log('main checkout: nothing to do'); return 0; }
  const conflict = identityConflict(ctx);
  if (conflict) { warn(conflict); return 1; }
  const { dryRun } = opts;
  const { tpl, out } = envPaths(ctx);

  if (dryRun) {
    log(`would set up ${ctx.wtId} (${plural(Object.keys(ctx.cfg.ports).length, 'port')}, ${plural(ctx.cfg.setup.length, 'setup step')}${fs.existsSync(tpl) ? ', env file from template' : ''})`);
    return 0;
  }

  // Ports: read, allocate and record under one repo-wide lock.
  const ports = await withLockAsync(path.join(ledgerDir(ctx.commonDir), 'ports'), async () => {
    const others = listLedgers(ctx.commonDir).filter((l) => l.data && l.wtId !== ctx.wtId && l.data.state !== 'torn-down');
    const taken = new Set(others.flatMap((l) => Object.values(l.data.ports || {})));
    const prev = readLedger(ctx.commonDir, ctx.wtId);
    const p = await allocatePorts(ctx.cfg.ports, ctx.wtId, (prev && prev.ports) || {}, taken);
    updateLedger(ctx.commonDir, ctx.wtId, (l) => {
      Object.assign(l, {
        repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, branch: ctx.branch,
        ticket: ctx.ticket, ports: p,
      });
      if (l.state === 'torn-down' || !l.state) Object.assign(l, { state: 'active', remoteBranchDeleted: false, tornDownAt: null, keptReason: null });
      return l;
    });
    return p;
  });
  try { registerRepo(ctx.repoRoot, ctx.repo); } catch (e) { warn(`repo registry not updated: ${e.message}`); }

  // Secrets: op inject into the env file, or no env file at all (never a stale one).
  let envNote = 'no env template';
  const problem = envOutputProblem(ctx.worktreePath, out);
  const prefix = itemPrefix(ctx);
  const badRefs = fs.existsSync(tpl) ? foreignRefs(fs.readFileSync(tpl, 'utf8'), prefix) : 0;
  const outputUsable = !problem;
  if (problem) {
    // Remove only a link, or a file setup made earlier: never a file the user created.
    if (!linkedAncestor(ctx.worktreePath, out) && (isSymlink(out) || (!isTracked(ctx.worktreePath, out) && managedOutput(ctx, out)))) removeFile(out);
    loud([`${path.basename(out)} ${problem}: nothing written to it.`, 'Make it a plain, git-ignored, untracked file, then rerun setup.']);
    envNote = `env file refused (${problem})`;
  } else if (badRefs) {
    removeFile(out);
    loud([`SECRETS NOT INJECTED: ${path.basename(tpl)} has ${plural(badRefs, 'reference')} outside op://agent-repos/${prefix}-...`,
      'Only this repo\'s items in the agent-repos vault may be injected; fix the template.']);
    envNote = 'secrets NOT injected (template refused)';
  } else if (fs.existsSync(tpl)) {
    const st = opStatus();
    if (!st.op || !st.hasToken) {
      removeFile(out);
      loud([`SECRETS NOT INJECTED: ${!st.op ? 'op (1Password CLI) not found' : 'no OP_SERVICE_ACCOUNT_TOKEN'}.`,
        `${path.basename(out)} holds no secrets; fix op, then rerun setup.`]);
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
  if (outputUsable && (fs.existsSync(out) || Object.keys(ports).length)) {
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

  try {
    runHook('setup', ctx.worktreePath, hookData(ctx, readLedger(ctx.commonDir, ctx.wtId), { dryRun: false }), ctx.commonDir);
  } catch (e) { warn(e.message); }

  const drift = path.join(homeDir(), '.agents', 'skills', 'repo-defaults', 'scripts', 'apply.mjs');
  if (fs.existsSync(drift)) {
    const r = run(process.execPath, [drift, '--check'], { cwd: ctx.worktreePath, env: stripToken(process.env) });
    if (r.status !== 0) warn('repo-defaults drift: run repo-defaults apply.mjs --check for details');
  }

  if (envGet(process.env, 'AGENT_WORKTREE_NO_SWEEP') !== '1') {
    try {
      spawnDetached(process.execPath, [SELF, 'sweep', '--quick', '--repo', ctx.repoRoot], { cwd: ctx.repoRoot, env: stripToken(process.env) });
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
function prsForBranch(cfg, dir, branch) {
  const head = ghJsonC(cfg, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', PR_FIELDS], { cwd: dir });
  const stacked = ghJsonC(cfg, ['pr', 'list', '--base', branch, '--state', 'open', '--limit', '100', '--json', 'number'], { cwd: dir });
  return { head: head || [], stacked: stacked || [] };
}

/**
 * Index of every PR in the repo by head and base branch (one gh call). When the result fills
 * the limit it may be truncated, so forBranch re-queries the branch itself.
 */
function prIndex(cfg, dir) {
  const limit = prLimit();
  const all = ghJsonC(cfg, ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS], { cwd: dir }) || [];
  const complete = all.length < limit;
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
    complete,
    known: (b) => byHead.has(b),
    forBranch: (b) => (complete ? { head: byHead.get(b) || [], stacked: openBase.get(b) || [] } : prsForBranch(cfg, dir, b)),
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
 * Changed or untracked files, or null when git status fails. Ignored files never count; a path
 * in ignore is skipped only while it is untracked (`??`), never a staged or tracked change.
 */
function dirtyCount(worktreePath, ignore = []) {
  const st = gitOut(['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath });
  if (st === null) return null;
  const skip = ignore.map((p) => normPath(p));
  return st.split(/\r?\n/).filter(Boolean).filter((line) => {
    if (!line.startsWith('?? ')) return true;
    const rel = line.slice(3).replace(/^"|"$/g, '');
    return !skip.includes(normPath(path.resolve(worktreePath, rel)));
  }).length;
}

/**
 * The teardown predicate. Returns {verdict, pr, detail} where verdict is one of
 * no-pr | queued | open | stacked | dirty | unpushed | eligible. Worktree checks run only
 * when worktreePath is given; tip checks run when tip and dir are given.
 */
export function assess({ prs, worktreePath, ignore = [], tip, dir }) {
  const pr = newest(prs.head);
  if (!pr) return { verdict: 'no-pr', pr: null, detail: 'no PR for this branch' };
  const inQueue = prs.head.find((p) => labelNames(p).some((n) => QUEUE_LABELS.includes(n)));
  if (inQueue) {
    return { verdict: 'queued', pr: inQueue, detail: `PR #${inQueue.number} is in the land queue (${labelNames(inQueue).filter((n) => QUEUE_LABELS.includes(n)).join(', ')})` };
  }
  if (pr.state === 'OPEN' || prs.head.some((p) => p.state === 'OPEN')) {
    const open = prs.head.find((p) => p.state === 'OPEN') || pr;
    return { verdict: 'open', pr: open, detail: `PR #${open.number} is open` };
  }
  if (prs.stacked.length) {
    return { verdict: 'stacked', pr, detail: `open PR ${prs.stacked.map((p) => `#${p.number}`).join(', ')} is based on this branch` };
  }
  if (worktreePath) {
    const n = dirtyCount(worktreePath, ignore);
    if (n === null) return { verdict: 'dirty', pr, detail: 'git status failed' };
    if (n) return { verdict: 'dirty', pr, detail: `${plural(n, 'changed or untracked file')}` };
  }
  const where = worktreePath || dir;
  if (where) {
    const why = unpushedReason(where, tip || gitOut(['rev-parse', 'HEAD'], { cwd: where }), pr);
    if (why) return { verdict: 'unpushed', pr, detail: why };
  }
  return { verdict: 'eligible', pr, detail: `PR #${pr.number} ${pr.state.toLowerCase()}` };
}

// ---------------------------------------------------------------- resource cleanup

function dockerCleanup(wtId, resources, dryRun) {
  const res = { containers: 0, volumes: 0, networks: 0, skipped: null, errors: [] };
  if (!which('docker')) { res.skipped = 'docker not installed'; return res; }
  const tracked = (kind) => resources.filter((r) => r.kind === kind && r.where === 'local').map((r) => r.id);
  const label = `label=agent.wt=${wtId}`;
  const sets = [
    ['containers', ['ps', '-aq', '--filter', label], 'docker-container', ['rm', '-f']],
    ['volumes', ['volume', 'ls', '-q', '--filter', label], 'docker-volume', ['volume', 'rm', '-f']],
    ['networks', ['network', 'ls', '-q', '--filter', label], 'docker-network', ['network', 'rm']],
  ];
  for (const [key, listArgs, kind, rmArgs] of sets) {
    const l = run('docker', listArgs);
    if (l.status !== 0) { res.errors.push(`docker ${key} list failed (exit ${l.status})`); continue; }
    const ids = l.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const extra = tracked(kind);
    const bad = extra.filter((id) => !DOCKER_ID.test(id));
    if (bad.length) res.errors.push(`${plural(bad.length, `invalid tracked ${kind} id`)}`);
    const all = [...new Set([...ids, ...extra.filter((id) => DOCKER_ID.test(id))])];
    if (dryRun) { res[key] = all.length; continue; }
    for (const id of all) {
      const r = run('docker', [...rmArgs, '--', id]);
      if (r.status === 0 || /no such/i.test(r.stderr)) res[key]++;
      else res.errors.push(`docker ${kind} could not be removed (exit ${r.status})`);
    }
  }
  return res;
}

/** Canonical paths of every worktree git lists for this repo, or null when listing fails. */
function liveWorktrees(repoRoot) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (r.status !== 0) return null;
  return parseWorktrees(r.stdout);
}

/**
 * Why a tracked path must not be deleted, or null. Allowed: inside this worktree, the temp
 * folder or ~/.cache (after resolving links). Never: the worktree itself, the main checkout or
 * git dir, another live worktree, or anything that contains one of those.
 */
export function deleteRefusal(p, ctx, live) {
  if (!path.isAbsolute(p)) return 'not absolute';
  const tgt = canonical(p);
  if (tgt === path.parse(tgt).root) return 'filesystem root';
  const wt = canonical(ctx.worktreePath);
  if (samePath(tgt, wt)) return 'is the worktree';
  const inWt = isUnder(tgt, wt);
  const home = canonical(homeDir());
  const trees = live.map((w) => canonical(w.path));
  const guards = [canonical(ctx.repoRoot), canonical(ctx.commonDir), home, wt, ...trees];
  if (guards.some((g) => isUnder(g, tgt))) return 'contains a protected folder';
  if (!inWt && (isUnder(tgt, canonical(ctx.repoRoot)) || isUnder(tgt, canonical(ctx.commonDir)))) return 'inside the main checkout or git dir';
  // Another worktree: anywhere outside this one, or nested inside it.
  if (trees.some((t) => !samePath(t, wt) && isUnder(tgt, t) && (!inWt || isUnder(t, wt)))) return 'inside another worktree';
  if (!inWt) {
    const tmp = canonical(os.tmpdir());
    const cache = canonical(path.join(homeDir(), '.cache'));
    const allowed = (isUnder(tgt, tmp) && !samePath(tgt, tmp)) || (isUnder(tgt, cache) && !samePath(tgt, cache));
    if (!allowed) return 'outside the worktree, the temp folder and ~/.cache';
  }
  return null;
}

/**
 * Teardown of everything recorded for one worktree, after the predicate said eligible.
 * Returns a summary object; .errors lists anything that needs the owner (then keep).
 */
async function cleanup(ctx, ledger, pr, { dryRun, worktreeGone }) {
  const s = { processes: 0, docker: null, paths: 0, envFile: false, remoteBranch: false, hook: null, crReview: null, left: 0, errors: [] };
  // Check the pattern before anything is removed: a bad one must not stop clean-up half-way.
  let pattern = null;
  try { pattern = ctx.cfg.remoteBranchDelete ? new RegExp(ctx.cfg.remoteBranchDelete) : null; } catch {
    s.errors.push('remoteBranchDelete in .agents/repo.json is not a valid pattern');
    return s;
  }
  const wt = ctx.worktreePath;
  const live = liveWorktrees(ctx.repoRoot);
  if (!live) { s.errors.push('git worktree list failed'); return s; }

  if (!worktreeGone) {
    const procs = listProcesses();
    if (!procs) { s.errors.push('process list failed: cannot tell whether the worktree is in use'); return s; }
    const inside = processesUnder(wt, procs);
    if (dryRun) s.processes = inside.length;
    else if (inside.length) {
      const r = stopProcesses(inside);
      s.processes = r.stopped;
      if (r.listFailed) { s.errors.push('process list failed: nothing stopped'); return s; }
      if (r.failed) { s.errors.push(`${plural(r.failed, 'process')} under the worktree could not be stopped`); return s; }
    }
  }

  try {
    s.hook = runHook('teardown', worktreeGone ? ctx.repoRoot : wt, hookData(ctx, ledger, { dryRun, worktreeGone }), ctx.commonDir);
  } catch (e) { s.hook = 'failed'; s.errors.push(e.message); }

  if (which('cr-review')) {
    const key = ctx.ticket || ctx.wtId;
    if (dryRun) s.crReview = 'would run';
    else {
      const r = run('cr-review', ['--cleanup', key], { cwd: worktreeGone ? ctx.repoRoot : wt, env: stripToken(process.env) });
      s.crReview = r.status === 0 ? 'ok' : `exit ${r.status}`;
      if (r.status !== 0) s.errors.push(`cr-review --cleanup ${key} exited ${r.status}`);
    }
  }

  const fresh = (!dryRun && readLedger(ctx.commonDir, ctx.wtId)) || ledger;
  s.docker = dockerCleanup(ctx.wtId, fresh.resources || [], dryRun);
  s.errors.push(...s.docker.errors);

  // Windows does not expose a process's working directory, so a server started inside the
  // worktree by an unrelated parent can escape the process match. Its port still shows it:
  // checked after the hook and Docker had their chance to stop it, before any file goes.
  if (!worktreeGone && !dryRun) {
    const busy = [];
    for (const [name, port] of Object.entries((ledger && ledger.ports) || {})) {
      if (Number.isInteger(port) && await portInUse(port)) busy.push(`${name} ${port}`);
    }
    if (busy.length) {
      s.errors.push(`${plural(busy.length, 'port')} of this worktree still in use (${busy.join(', ')}): a process may still run in it`);
      return s;
    }
  }

  for (const r of fresh.resources || []) {
    if (!isPathKind(r.kind) || r.where !== 'local') continue;
    const why = deleteRefusal(r.id, ctx, live);
    if (why) { s.errors.push(`refused to delete tracked ${r.kind} (${why})`); continue; }
    if (!fs.existsSync(r.id) && !isSymlink(r.id)) continue;
    if (dryRun) { s.paths++; continue; }
    try {
      if (isSymlink(r.id)) fs.unlinkSync(r.id);
      else fs.rmSync(r.id, { recursive: true, force: true });
      s.paths++;
    } catch (e) { s.errors.push(`could not delete tracked ${r.kind}: ${e.code || e.message}`); }
  }

  if (!worktreeGone) {
    const { out } = envPaths(ctx);
    if ((fs.existsSync(out) || isSymlink(out)) && !linkedAncestor(wt, out) && !isTracked(wt, out)) {
      s.envFile = dryRun ? 'would delete' : removeFile(out);
      if (s.envFile === false) s.errors.push(`could not delete ${path.basename(out)}`);
    }
  }

  if (pr && pr.state === 'MERGED' && ctx.branch && pattern && pattern.test(ctx.branch) && !ledger.remoteBranchDeleted) {
    const ref = `repos/{owner}/{repo}/git/ref/heads/${ctx.branch.split('/').map(encodeURIComponent).join('/')}`;
    const cwd = worktreeGone ? ctx.repoRoot : wt;
    const got = ghRun(ctx.cfg, ['api', ref], { cwd });
    if (got.status !== 0) {
      if (/HTTP 404|Not Found/i.test(got.stderr + got.stdout)) s.remoteBranch = true;
      else s.errors.push(`could not read the remote branch (gh exit ${got.status})`);
    } else {
      let sha = null;
      try { sha = JSON.parse(got.stdout).object.sha; } catch { /* not JSON */ }
      if (sha !== pr.headRefOid) {
        s.remoteBranch = 'moved';
        warn(`remote branch moved after PR #${pr.number} merged; left in place`);
      } else if (dryRun) s.remoteBranch = 'would delete';
      else {
        const d = ghRun(ctx.cfg, ['api', '-X', 'DELETE', ref.replace('/git/ref/', '/git/refs/')], { cwd });
        // Success, or the ref is already gone (404, or 422 "Reference does not exist").
        if (d.status === 0 || /HTTP 404|reference does not exist/i.test(d.stderr + d.stdout)) s.remoteBranch = true;
        else s.errors.push(`remote branch not deleted (gh exit ${d.status})`);
      }
    }
  }

  const known = new Set(['file', 'dir', 'cache', 'path', 'env-file', 'docker-container', 'docker-volume', 'docker-network']);
  const after = (!dryRun && readLedger(ctx.commonDir, ctx.wtId)) || fresh;
  s.left = (after.resources || []).filter((r) => !known.has(r.kind) || r.where !== 'local').length;
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
  if (s.remoteBranch === true) parts.push('remote branch deleted');
  if (s.remoteBranch === 'moved') parts.push('remote branch moved (kept)');
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
  const conflict = identityConflict(ctx);
  if (conflict) { warn(conflict); return 1; }
  const release = opts.dryRun ? () => {} : tryLock(path.join(ledgerDir(ctx.commonDir), `${ctx.wtId}.teardown.lock`));
  if (!release) { warn('keep: another teardown of this worktree is running'); return 1; }
  try { return await teardown(ctx, opts); } finally { release(); }
}

async function teardown(ctx, { dryRun }) {
  const ledger = readLedger(ctx.commonDir, ctx.wtId) || { resources: [], ports: {} };
  const note = (state, keptReason, pr) => {
    if (dryRun) return;
    // A detached HEAD keeps the branch this worktree last had, so sweep can still assess it.
    updateLedger(ctx.commonDir, ctx.wtId, (l) => Object.assign(l, {
      repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath, branch: ctx.branch || l.branch || null,
      ticket: ctx.branch ? ctx.ticket : l.ticket || null, state, keptReason, prNumber: pr ? pr.number : l.prNumber || null,
      prState: pr ? pr.state : l.prState || null,
    }));
  };
  if (!ctx.branch) {
    const n = Number(gitOut(['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags'], { cwd: ctx.worktreePath }) ?? NaN);
    if (!Number.isFinite(n) || n > 0) {
      const why = Number.isFinite(n) ? `detached HEAD with ${plural(n, 'commit')} on no branch, remote or tag` : 'detached HEAD; cannot count its commits';
      warn(`keep: ${why}`);
      note('kept', why, null);
      return 1;
    }
    const dirty = dirtyCount(ctx.worktreePath, envIgnore(ctx.worktreePath, envPaths(ctx).out));
    if (dirty !== 0) {
      const why = dirty === null ? 'detached HEAD; git status failed' : `detached HEAD with ${plural(dirty, 'changed or untracked file')}`;
      warn(`keep: ${why}`);
      note('kept', why, null);
      return 1;
    }
    log('detached HEAD: nothing removed');
    note('active', 'detached HEAD', null);
    return 0;
  }

  let prs;
  try { prs = prsForBranch(ctx.cfg, ctx.worktreePath, ctx.branch); } catch (e) {
    warn(`keep: cannot read PR state (${e.message}); nothing removed`);
    note('kept', 'PR state unknown', null);
    return 1;
  }
  const { out } = envPaths(ctx);
  const a = assess({ prs, worktreePath: ctx.worktreePath, ignore: envIgnore(ctx.worktreePath, out) });
  if (a.verdict === 'no-pr' || a.verdict === 'open') {
    // Exit 0 lets T3 remove the worktree, which would lose uncommitted files.
    const dirty = dirtyCount(ctx.worktreePath, envIgnore(ctx.worktreePath, out));
    if (dirty !== 0) {
      const why = `${a.detail}; ${dirty === null ? 'git status failed' : plural(dirty, 'changed or untracked file')}`;
      warn(`keep: ${why}`);
      note('kept', why, a.pr);
      return 1;
    }
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
  if (dryRun) {
    if (s.errors.length) for (const e of s.errors) warn(e);
    log(`dry run, ${a.detail}: would do: ${describe(s)}`);
    return 0;
  }
  // Record the identity too: a worktree set up without this engine has no ledger yet.
  updateLedger(ctx.commonDir, ctx.wtId, (l) => Object.assign(l, {
    repo: ctx.repo, repoRoot: ctx.repoRoot, worktreePath: ctx.worktreePath,
    branch: ctx.branch || l.branch || null, ticket: ctx.branch ? ctx.ticket : l.ticket || null,
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

export function parseWorktrees(text) {
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
  const id = gitIdentity(root);
  if (!id) return { repo: path.basename(root), errors: ['not a git checkout'] };
  let repo;
  try { repo = repoName(loadConfig(id.repoRoot), id.repoRoot); } catch (e) {
    return { repo: path.basename(id.repoRoot), errors: [`.agents/repo.json: ${e.message}`] };
  }
  const release = tryLock(path.join(ledgerDir(id.commonDir), 'sweep.lock'));
  if (!release) return { repo, skipped: 'another sweep of this repo is running', errors: [] };
  try { return await sweepLocked(id, repo, opts); } finally { release(); }
}

async function sweepLocked(id, repo, { dryRun, quick }) {
  const repoRoot = id.repoRoot;
  const cfg = loadConfig(repoRoot);
  const base = baseBranch(cfg, repoRoot);
  const r = {
    repo, ledgersFinished: 0, ledgersRemoved: 0, worktreesRemoved: 0, branchesDeleted: 0,
    containersRemoved: 0, kept: [], errors: [],
  };
  if (!dryRun) git(['worktree', 'prune'], { cwd: repoRoot });

  let worktrees = liveWorktrees(repoRoot);
  if (!worktrees) { r.errors.push('git worktree list failed: nothing swept'); return r; }

  let index = null;
  try { index = prIndex(cfg, repoRoot); } catch (e) { r.errors.push(`PR state unavailable (${e.message}): PR-dependent steps skipped`); }
  const forBranch = (b) => {
    try { return index.forBranch(b); } catch (e) { r.errors.push(`${b}: ${e.message}`); return null; }
  };

  const live = worktrees.filter((w) => !w.prunable);
  const liveKeys = new Set(live.map((w) => canonKey(w.path)));
  const liveBranches = new Set(live.map((w) => w.branch).filter(Boolean));
  const finished = new Set(); // ledgers this run finished (or, in a dry run, would finish)
  const keepLedger = (wtId, why) => {
    if (!dryRun) updateLedger(id.commonDir, wtId, (l) => Object.assign(l, { state: 'kept', keptReason: why }));
  };

  // 1. Ledgers whose worktree is gone (not listed and not on disk).
  for (const { wtId, data, error } of listLedgers(id.commonDir)) {
    if (error) { r.errors.push(`${wtId}: ${error}`); continue; }
    const p = data.worktreePath;
    if (p && (liveKeys.has(canonKey(p)) || fs.existsSync(p))) continue;
    if (data.branch && liveBranches.has(data.branch)) { r.kept.push(`${wtId}: branch checked out in another worktree`); continue; }
    if (data.state === 'torn-down') {
      const d = dockerCleanup(wtId, data.resources || [], dryRun);
      r.containersRemoved += d.containers || 0;
      if (d.errors.length) { r.errors.push(`${wtId}: ${d.errors.join('; ')}`); continue; }
      if (!dryRun) deleteLedger(id.commonDir, wtId);
      r.ledgersRemoved++;
      continue;
    }
    // Without a recorded worktree, path checks would measure against the main checkout.
    if (!p) { r.kept.push(`${wtId}: no worktree path recorded`); continue; }
    const ctx = repoContext(repoRoot, cfg, repo, id.commonDir, { worktreePath: p, branch: data.branch, wtId });
    if (!index) continue;
    if (!data.branch) { r.kept.push(`${wtId}: no branch recorded`); continue; }
    const tip = gitOut(['rev-parse', '--verify', '-q', `refs/heads/${data.branch}`], { cwd: repoRoot });
    if (!tip) { r.kept.push(`${wtId}: local branch missing; cannot prove it was pushed`); continue; }
    const prs = forBranch(data.branch);
    if (!prs) continue;
    const a = assess({ prs, tip, dir: repoRoot });
    if (a.verdict !== 'eligible') { r.kept.push(`${wtId}: ${a.detail}`); continue; }
    const lock = dryRun ? () => {} : tryLock(path.join(ledgerDir(id.commonDir), `${wtId}.teardown.lock`));
    if (!lock) { r.kept.push(`${wtId}: teardown running`); continue; }
    try {
      const s = await cleanup(ctx, data, a.pr, { dryRun, worktreeGone: true });
      r.containersRemoved += s.docker && s.docker.containers ? s.docker.containers : 0;
      if (s.errors.length) {
        r.errors.push(`${wtId}: ${s.errors.join('; ')}`);
        if (!dryRun) keepLedger(wtId, s.errors.join('; '));
        continue;
      }
      r.ledgersFinished++;
      finished.add(wtId);
      if (!dryRun) {
        updateLedger(id.commonDir, wtId, (l) => Object.assign(l, {
          state: 'torn-down', keptReason: null, tornDownAt: new Date().toISOString(),
          remoteBranchDeleted: Boolean(l.remoteBranchDeleted || s.remoteBranch === true),
          prNumber: a.pr.number, prState: a.pr.state,
        }));
      }
    } finally { lock(); }
  }

  // 2. Hand-made worktrees outside the T3 root (T3 removes its own). Not in --quick.
  if (!quick && index) {
    const lander = canonKey(`${repoRoot}-lander`);
    const t3 = canonical(t3Root());
    let procs;
    for (const w of worktrees) {
      if (samePath(w.path, repoRoot) || w.bare || w.locked || w.prunable || !w.branch) continue;
      if (!fs.existsSync(w.path)) continue;
      if (canonKey(w.path) === lander || isUnder(canonical(w.path), t3)) continue;
      const name = path.basename(w.path);
      const wtId = makeWtId(repo, w.path);
      let wcfg;
      try { wcfg = loadConfig(w.path); } catch (e) { r.errors.push(`${name}: .agents/repo.json: ${e.message}`); continue; }
      const ctx = repoContext(repoRoot, wcfg, repo, id.commonDir, { worktreePath: w.path, branch: w.branch, wtId });
      const prs = forBranch(w.branch);
      if (!prs) continue;
      let out;
      try { ({ out } = envPaths(ctx)); } catch (e) { r.errors.push(`${name}: ${e.message}`); continue; }
      const a = assess({ prs, worktreePath: w.path, ignore: envIgnore(w.path, out) });
      if (a.verdict !== 'eligible') { r.kept.push(`${name}: ${a.detail}`); continue; }
      if (procs === undefined) procs = listProcesses();
      if (!procs) { r.kept.push(`${name}: process list failed`); continue; }
      if (processesUnder(w.path, procs).length) { r.kept.push(`${name}: processes running inside`); continue; }
      const lock = dryRun ? () => {} : tryLock(path.join(ledgerDir(id.commonDir), `${wtId}.teardown.lock`));
      if (!lock) { r.kept.push(`${name}: teardown running`); continue; }
      try {
        let ledger;
        try { ledger = readLedger(id.commonDir, wtId) || { resources: [], ports: {} }; } catch (e) { r.errors.push(`${name}: ${e.message}`); continue; }
        const s = await cleanup(ctx, ledger, a.pr, { dryRun, worktreeGone: false });
        if (s.errors.length) {
          r.errors.push(`${name}: ${s.errors.join('; ')}`);
          if (!dryRun && readLedger(id.commonDir, wtId)) keepLedger(wtId, s.errors.join('; '));
          continue;
        }
        finished.add(wtId);
        if (dryRun) { r.worktreesRemoved++; continue; }
        const rm = git(['worktree', 'remove', w.path], { cwd: repoRoot });
        if (rm.status !== 0) { r.kept.push(`${name}: git worktree remove refused (${firstLine(rm.stderr)})`); continue; }
        r.worktreesRemoved++;
        if (readLedger(id.commonDir, wtId)) deleteLedger(id.commonDir, wtId);
      } finally { lock(); }
    }
    if (!dryRun) worktrees = liveWorktrees(repoRoot);
  }

  // 3. Local branches whose PR merged or closed, with nothing unpushed.
  if (index && worktrees) {
    const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
    // A ledger that is not finished still needs its branch to prove, later, that it was pushed.
    // An unreadable ledger may need any branch, so then no branch is deleted.
    const ledgers = listLedgers(id.commonDir);
    const unreadable = ledgers.some((l) => l.error);
    const pending = new Set(ledgers
      .filter(({ wtId, data: d }) => d && d.state !== 'torn-down' && d.branch && !finished.has(wtId))
      .map(({ data: d }) => d.branch));
    // lstrip=2 gives the exact branch name even when a tag has the same name.
    const refs = unreadable ? [] : (gitOut(['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', 'refs/heads'], { cwd: repoRoot }) || '').split(/\r?\n/).filter(Boolean);
    if (unreadable) r.kept.push('branches: not swept while a ledger is unreadable');
    for (const line of refs) {
      const [branch, tip] = line.split(' ');
      if (branch === base || branch === 'agent-landing-lock' || checkedOut.has(branch)) continue;
      if (pending.has(branch)) { r.kept.push(`branch ${branch}: an unfinished ledger still needs it`); continue; }
      if (index.complete && !index.known(branch)) continue;
      const prs = forBranch(branch);
      if (!prs || !prs.head.length) continue;
      const a = assess({ prs, tip, dir: repoRoot });
      if (a.verdict !== 'eligible') { r.kept.push(`branch ${branch}: ${a.detail}`); continue; }
      if (!dryRun) {
        const d = git(['branch', '-D', branch], { cwd: repoRoot });
        if (d.status !== 0) { r.errors.push(`branch ${branch}: delete failed`); continue; }
      }
      r.branchesDeleted++;
    }
  } else if (!worktrees) r.errors.push('git worktree list failed: branches not swept');

  // 4. The repo's own sweep hook (repo-wide leftovers such as aged preview databases).
  try {
    const data = {
      repo, repoRoot, worktreePath: repoRoot, wtId: null, branch: null, ticket: null, ports: {},
      dryRun: Boolean(dryRun), worktreeGone: false,
      ledgers: listLedgers(id.commonDir).filter((l) => l.data).map(({ wtId, data: d }) => ({ wtId, branch: d.branch, state: d.state, worktreePath: d.worktreePath, resources: d.resources || [] })),
    };
    r.hook = runHook('sweep', repoRoot, data, id.commonDir);
  } catch (e) { r.errors.push(e.message); }
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
      if (r.skipped) { log(`sweep ${r.repo}: skipped (${r.skipped})`); continue; }
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
    for (const { wtId, data: d, error } of listLedgers(id.commonDir)) {
      const data = d || { state: 'unreadable', keptReason: error };
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
  const [kind, rawId] = opts._.slice(1);
  if (!kind || !rawId) { warn(`usage: ${remove ? 'untrack' : 'track'} <kind> <id>${remove ? '' : ' [--where <host>]'}`); return 2; }
  const ctx = resolveContext(startDir(opts));
  if (!ctx) { warn('not inside a git checkout'); return 2; }
  if (ctx.isMain) { warn('main checkout: resources are tracked per worktree'); return 2; }
  const conflict = identityConflict(ctx);
  if (conflict) { warn(conflict); return 1; }
  const id = normalizeTrack(kind, rawId, ctx.worktreePath);
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

// Compare canonical paths: Node resolves links in import.meta.url but not in argv[1].
if (process.argv[1] && canonKey(process.argv[1]) === canonKey(SELF)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
