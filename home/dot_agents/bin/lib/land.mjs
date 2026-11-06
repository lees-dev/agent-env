// Shared helpers for land-pr.mjs and land-queue.mjs (the local land queue).
// Node >= 22, ESM, no dependencies. Process spawning, .agents/repo.json, the repo registry and
// JSON state files come from the lifecycle libs (proc, repo, ledger, op); this file holds only
// what is about landing. No child but op ever sees the 1Password service-account token, and
// none is started here. Output is counts, PR numbers, SHAs and labels; never a secret value.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readRegistry, withLock, writeJsonAtomic } from './ledger.mjs';
import { captureToken, homeDir, stripToken } from './op.mjs';
import { bornAfter, listProcesses, stopProcesses } from './processes.mjs';
import { isWindows, prepare, run as procRun, sleepMs, splitArgv as procSplitArgv } from './proc.mjs';
import { baseBranch, canonKey, gitIdentity, loadConfig } from './repo.mjs';

// Entry points call this first: OP_SERVICE_ACCOUNT_TOKEN leaves process.env, so no child (git
// hooks, gates, gh) can inherit it, whichever env a call site builds.
export { captureToken };

export const LOCK_REF = 'agent-landing-lock';
export const LABELS = {
  queued: { color: '1d76db', description: 'Gated; waiting for the lander (land-queue)' },
  landing: { color: '5319e7', description: 'The lander is landing this PR now' },
  'queue-blocked': { color: 'd93f0b', description: 'Bounced by the lander; see the latest comment' },
  'queue-hold': { color: 'b60205', description: 'Held by the owner or a full stop: never landed automatically' },
  'queue-next': { color: 'fbca04', description: 'Owner only: land before the rest of the queue' },
  'queue-waiting': { color: 'c5def5', description: 'Gated and ready, but the queue was full' },
};
// Repo-wide pause: a GitHub Actions repo variable, never a PR label.
export const PAUSE_VAR = 'AGENT_LANDING_PAUSED';
export const DEFAULT_PRIORITY = 3;
export const MAX_QUEUED = 5; // queued + landing PRs per repo

export const BOUNCE_MARKER = '<!-- land-queue:bounce -->';

// ---------------------------------------------------------------- errors and output

export class LandError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

export function parseArgs(argv, spec) {
  // spec: { flags: Set of boolean flags, options: Set of value options }
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (spec.flags.has(name)) { out[name] = true; continue; }
      if (spec.options.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new LandError(`--${name} needs a value`, 2);
        out[name] = v;
        continue;
      }
      throw new LandError(`unknown option ${a}`, 2);
    }
    out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- processes

// Repo commands (setup, gates, sweeps, mergeCmd, ghWrapper) are split exactly as the worktree
// engine splits them: quotes group words, shell operators are refused.
export function splitArgv(str) {
  try { return procSplitArgv(str); } catch (e) { throw new LandError(e.message, 2); }
}

// Environment for every child: the caller's, minus OP_SERVICE_ACCOUNT_TOKEN, plus `extra`.
export function childEnv(extra = {}) {
  return { ...stripToken(process.env), ...extra };
}

// Run [cmd, ...args] synchronously (shell: false; stdin is `input`, else ignored).
export function run(argv, { cwd, env = childEnv(), input } = {}) {
  const r = procRun(argv[0], argv.slice(1), { cwd, env, input });
  const stderr = r.stderr || (r.error ? String(r.error.message || r.error) : '');
  return { status: r.status, stdout: r.stdout, stderr };
}

// Run a repo command asynchronously. Its output is discarded, never kept: gate output can hold
// secret values, and only an exit status leaves this function. onTick runs every tickMs while it
// runs (the lock refresh). After timeoutMs the processes the command provably owns are stopped
// (see ownedTree) and its process group or tree is signalled, and this waits (bounded) for the
// command to exit. A timeout always reports `stuck`: a process the command started and
// orphaned earlier (detached, its parent gone) cannot be found, so nothing proves the checkout
// is free, and the caller keeps the landing lock. onTick returning false (the lock refresh
// failed) stops the command the same way, at once: { stopped: true }, also stuck.
// { status, timedOut, stopped, stuck }.
export function runAsync(argv, { cwd, env = childEnv(), tickMs = 0, onTick, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let prepared;
    try { prepared = prepare(argv[0], argv.slice(1), { cwd, env }); } catch { resolve({ status: 127, timedOut: false }); return; }
    const [file, args, options] = prepared;
    const child = spawn(file, args, { ...options, stdio: 'ignore', detached: !isWindows });
    let timedOut = false;
    let stopped = false;
    let stuck = false;
    let ending = false;
    const timers = [];
    // Stop the command: what it provably owns (one snapshot while its tree is intact), then the
    // command itself; then wait (bounded) for it to exit.
    const terminate = () => {
      if (ending) return;
      ending = true;
      const procs = listProcesses(env);
      stopOwned(procs ? ownedTree(procs, child.pid, process.pid) : [], env);
      killTree(child, 'SIGTERM');
      timers.push(setTimeout(() => killTree(child, 'SIGKILL'), 3000));
      // A command that does not exit is not waited on forever.
      timers.push(setTimeout(() => done(124), stuckMs()));
    };
    if (tickMs > 0 && onTick) {
      timers.push(setInterval(() => {
        let ok = true;
        try { ok = onTick() !== false; } catch { ok = false; }
        if (!ok && !ending) { stopped = true; terminate(); }
      }, tickMs));
    }
    if (timeoutMs > 0) timers.push(setTimeout(() => { if (!ending) { timedOut = true; terminate(); } }, timeoutMs));
    let finished = false;
    const done = (status) => {
      if (finished) return;
      finished = true;
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      if (timedOut || stopped) {
        // On Unix, anything left in its group goes with it. Whatever was stopped, nothing proves
        // that every process the command started is gone: it is stuck.
        if (!isWindows) killTree(child, 'SIGKILL');
        stuck = true;
        // A command still running must not keep this process from exiting.
        child.unref();
      }
      resolve({ status, timedOut, stopped, stuck });
    };
    child.on('error', () => done(127));
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

// The processes a command provably owns, from one process snapshot: the command itself, only
// when that pid's parent is this process (a reused pid is not); then each child of an owned
// process, only when it was created after that parent (a pid reused by an older, unrelated
// process is not a child). Unknown start times prove nothing, so those are left out. Nothing
// else (cwd, arguments, names) ever makes a process the command's.
export function ownedTree(procs, rootPid, selfPid) {
  const root = procs.find((p) => p.pid === rootPid);
  if (!root || root.ppid !== selfPid) return [];
  const owned = new Map([[root.pid, root]]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const c of procs) {
      if (c.ppid !== parent.pid || owned.has(c.pid) || !bornAfter(c, parent)) continue;
      owned.set(c.pid, c);
      queue.push(c);
    }
  }
  return [...owned.values()];
}

// Stop the given processes; each pid is re-checked (start time, command) before each signal,
// so a reused pid is never touched.
function stopOwned(list, env) {
  if (!list || !list.length || process.env.AGENT_LAND_TEST_NO_KILL === '1') return;
  stopProcesses(list, env);
}

// Signal the command itself. Unix: its own process group (it was spawned detached, so it leads
// one; a group id is not reused while the group exists). Windows: only the command, through our
// own process handle: a tree kill by parent pid (taskkill /T) could reach a process that merely
// reuses a pid, so the rest of the tree goes only through ownedTree's identity checks.
function killTree(child, signal) {
  if (!child?.pid) return;
  // Test hook: simulate a process tree that cannot be stopped (nothing is signalled).
  if (process.env.AGENT_LAND_TEST_NO_KILL === '1') return;
  if (isWindows) { try { child.kill(); } catch { /* already gone */ } return; }
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

// How long a timed-out command may take to exit after it was signalled (AGENT_LAND_STUCK_MS
// overrides the 30 s for tests).
function stuckMs() {
  const v = Number(process.env.AGENT_LAND_STUCK_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

// The time one repo command may run (gate, setup, sweep): repo.json commandTimeoutMin (default
// 60), or AGENT_LAND_CMD_TIMEOUT_MS for tests.
export function commandTimeoutMs(cfg) {
  const v = Number(process.env.AGENT_LAND_CMD_TIMEOUT_MS);
  if (Number.isFinite(v) && v > 0) return v;
  const min = Number(cfg?.commandTimeoutMin);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60000;
}

export function pollMs() {
  const v = Number(process.env.AGENT_LAND_POLL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

// How often the lock is refreshed while a repo command runs: a third of its ttl (lockTtlMin is
// at least 1, so at least every 20 s), well inside the ttl (AGENT_LAND_TICK_MS overrides it for
// tests).
export function tickMs(ttlMin) {
  const v = Number(process.env.AGENT_LAND_TICK_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return Math.floor((Math.max(1, Number(ttlMin) || 45) * 60000) / 3);
}

// ---------------------------------------------------------------- redaction

// Gate output can quote environment values. Mask anything shaped like a credential before it
// goes into a PR comment.
export function scrub(text) {
  return String(text)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ops_[A-Za-z0-9]{20,}|xox[abpors]-[A-Za-z0-9-]{10,}|tskey-[A-Za-z0-9-]{8,})/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]')
    .replace(/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqps?):\/\/[^\s'"]+/gi, '$1://[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]');
}

// ---------------------------------------------------------------- git

// git runs without the token too: a rebase or checkout in the lander checkout runs repo hooks.
export function git(args, opts = {}) {
  return run(['git', ...args], opts);
}

export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.status !== 0) throw new LandError(`git ${args[0]} failed: ${firstLine(r.stderr || r.stdout)}`);
  return r.stdout.trim();
}

export function firstLine(s) {
  return scrub(String(s || '').trim().split(/\r?\n/)[0] || '').slice(0, 300);
}

export function isAncestor(ancestor, descendant, cwd) {
  const r = git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new LandError(`git merge-base --is-ancestor failed: ${firstLine(r.stderr)}`);
}

export function fetchBranch(cwd, branch) {
  gitOk(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  return gitOk(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], { cwd });
}

function identity(cwd) {
  const id = gitIdentity(cwd, childEnv());
  if (!id) throw new LandError('not inside a git checkout', 2);
  return id;
}

// The checkout `cwd` is in, and the main checkout of its repository (the engine's repoRoot:
// the lander checkout is <main checkout>-lander, which the engine's sweeps skip).
export function repoTop(cwd = process.cwd()) { return identity(cwd).worktreePath; }
export function mainCheckout(cwd) { return identity(cwd).repoRoot; }

export function slugFromRemote(cwd) {
  const r = git(['remote', 'get-url', 'origin'], { cwd });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// range-diff status lines: "1:  abc1234 = 1:  def5678 subject". Anything but "=" is a change.
export function rangeDiffChanges(out) {
  const lines = out.split(/\r?\n/).filter((l) => /^\s*(\d+|-):\s+([0-9a-f]+|-+)\s+[=!<>]\s+/.test(l));
  const changed = lines.filter((l) => !/^\s*(\d+|-):\s+([0-9a-f]+|-+)\s+=\s+/.test(l));
  return { total: lines.length, changed };
}

// ---------------------------------------------------------------- repo config

// .agents/repo.json through the engine's loader (same defaults and validation), plus what
// landing needs: a resolved base, affectedGate falling back to gate, numeric limits, no command
// left as a TODO(repo-defaults) placeholder, and (needGate) a gate: without one a rebase cannot be
// validated, so nothing lands.
export function loadRepoConfig(root, { needGate = true } = {}) {
  let cfg;
  try { cfg = { ...loadConfig(root) }; } catch (e) { throw new LandError(e.message, 2); }
  cfg.base = baseBranch(cfg, root, childEnv());
  if (!cfg.affectedGate.length) cfg.affectedGate = cfg.gate;
  if (!['squash', 'merge', 'rebase'].includes(cfg.mergeMethod)) throw new LandError('mergeMethod must be squash, merge or rebase', 2);
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  cfg.lockTtlMin = Math.max(1, num(cfg.lockTtlMin, 45));
  cfg.maxQueued = num(cfg.maxQueued, MAX_QUEUED);
  cfg.sweepEveryMerges = num(cfg.sweepEveryMerges, 5);
  for (const k of ['setup', 'gate', 'affectedGate']) {
    if (cfg[k].some((c) => typeof c !== 'string' || /TODO\(repo-defaults\)/.test(c))) {
      throw new LandError(`.agents/repo.json ${k} still has a TODO(repo-defaults) or a non-string entry`, 2);
    }
  }
  if (needGate && !cfg.affectedGate.some((c) => c.trim())) {
    throw new LandError('.agents/repo.json has no gate or affectedGate command: nothing lands until the repo has one (repo-defaults)', 2);
  }
  return cfg;
}

// ---------------------------------------------------------------- gh

export class Gh {
  constructor({ repo, wrapper = null, env = childEnv() }) {
    this.repo = repo;
    this.wrapper = wrapper ? splitArgv(wrapper) : null;
    this.env = env;
  }

  call(args, { input = '', useWrapper = false } = {}) {
    const argv = useWrapper && this.wrapper ? [...this.wrapper, ...args] : ['gh', ...args];
    return run(argv, { env: this.env, input });
  }

  ok(args, opts) {
    const r = this.call(args, opts);
    if (r.status !== 0) throw new LandError(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr || r.stdout)}`);
    return r.stdout;
  }

  json(args, opts) {
    const out = this.ok(args, opts);
    try { return JSON.parse(out); } catch { throw new LandError(`gh ${args.slice(0, 2).join(' ')} returned no JSON`); }
  }

  // REST call. Returns { ok, status, data }. Field values are strings (-f) unless typed (-F).
  api(method, route, { fields = {}, typed = {} } = {}) {
    const args = ['api', '-X', method, route];
    for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`);
    for (const [k, v] of Object.entries(typed)) args.push('-F', `${k}=${v}`);
    const r = this.call(args);
    if (r.status === 0) {
      let data = null;
      try { data = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { data = null; }
      return { ok: true, status: 200, data };
    }
    const m = `${r.stderr}\n${r.stdout}`.match(/HTTP (\d{3})/);
    return { ok: false, status: m ? Number(m[1]) : 0, data: null, message: firstLine(r.stderr || r.stdout) };
  }

  prView(n, fields = PR_FIELDS) {
    return this.json(['pr', 'view', String(n), '--repo', this.repo, '--json', fields]);
  }

  prList(label) {
    return this.json(['pr', 'list', '--repo', this.repo, '--state', 'open', '--label', label, '--limit', '200', '--json', PR_FIELDS]);
  }

  prEdit(n, { add = [], remove = [], body = null } = {}) {
    const args = ['pr', 'edit', String(n), '--repo', this.repo];
    if (add.length) args.push('--add-label', add.join(','));
    if (remove.length) args.push('--remove-label', remove.join(','));
    if (body !== null) args.push('--body-file', '-');
    if (args.length === 5) return;
    this.ok(args, { input: body ?? '' });
  }

  prComment(n, body) {
    this.ok(['pr', 'comment', String(n), '--repo', this.repo, '--body-file', '-'], { input: body });
  }

  ensureLabels() {
    const have = new Set(this.json(['label', 'list', '--repo', this.repo, '--limit', '500', '--json', 'name']).map((l) => l.name));
    let created = 0;
    for (const [name, l] of Object.entries(LABELS)) {
      if (have.has(name)) continue;
      const r = this.call(['label', 'create', name, '--repo', this.repo, '--color', l.color, '--description', l.description]);
      if (r.status !== 0 && !/already exists/i.test(r.stderr)) throw new LandError(`gh label create ${name} failed: ${firstLine(r.stderr)}`);
      created++;
    }
    return created;
  }

  // AGENT_LANDING_PAUSED=1 on the repo pauses every merge (land-pr and the lander).
  isPaused() {
    const r = this.api('GET', `repos/${this.repo}/actions/variables/${PAUSE_VAR}`);
    if (r.ok) return String(r.data?.value ?? '').trim() === '1';
    if (r.status === 404) return false;
    throw new LandError(`could not read the ${PAUSE_VAR} repo variable (HTTP ${r.status})`);
  }

  setPaused(on) {
    const route = `repos/${this.repo}/actions/variables`;
    if (!on) {
      const r = this.api('DELETE', `${route}/${PAUSE_VAR}`);
      if (!r.ok && r.status !== 404) throw new LandError(`could not clear ${PAUSE_VAR} (HTTP ${r.status})`);
      return;
    }
    let r = this.api('POST', route, { fields: { name: PAUSE_VAR, value: '1' } });
    if (!r.ok && (r.status === 409 || r.status === 422)) r = this.api('PATCH', `${route}/${PAUSE_VAR}`, { fields: { name: PAUSE_VAR, value: '1' } });
    if (!r.ok) throw new LandError(`could not set ${PAUSE_VAR} (HTTP ${r.status})`);
  }
}

export const PR_FIELDS = 'number,title,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,labels,body,createdAt,mergeCommit,url';

export function labelNames(pr) {
  return (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

// Swap labels on a PR, touching only labels that need to change.
export function setLabels(gh, pr, { add = [], remove = [] }) {
  const have = new Set(labelNames(pr));
  const a = add.filter((l) => !have.has(l));
  const r = remove.filter((l) => have.has(l));
  if (a.length || r.length) gh.prEdit(pr.number, { add: a, remove: r });
  pr.labels = [...[...have].filter((l) => !r.includes(l)), ...a].map((name) => ({ name }));
}

export function waitForPr(gh, n, predicate, tries = 10) {
  let pr = gh.prView(n);
  for (let i = 0; i < tries && !predicate(pr); i++) {
    sleepMs(pollMs());
    pr = gh.prView(n);
  }
  return pr;
}

// ---------------------------------------------------------------- landing lock

export function lockMessage({ host = os.hostname(), pid = process.pid, at = new Date().toISOString(), ttl }) {
  return `${LOCK_REF} host=${host} pid=${pid} at=${at} ttl=${ttl}`;
}

export function parseLockMessage(msg) {
  const out = {};
  for (const m of String(msg || '').matchAll(/\b(host|pid|at|ttl)=(\S+)/g)) out[m[1]] = m[2];
  if (out.pid) out.pid = Number(out.pid);
  if (out.ttl) out.ttl = Number(out.ttl);
  return out;
}

export function lockAgeMin(info, now = Date.now()) {
  const t = Date.parse(info.at || '');
  return Number.isFinite(t) ? (now - t) / 60000 : Infinity;
}

export function isStale(info, ttlDefault, now = Date.now()) {
  const ttl = Number(info.ttl) > 0 ? Number(info.ttl) : ttlDefault;
  return lockAgeMin(info, now) > ttl;
}

// The lock is the ref refs/heads/agent-landing-lock on GitHub. Creating a ref is atomic:
// 201 means we hold it, 422 means someone else does. Refreshing and reclaiming move the ref
// by fast-forward only (non-forced PATCH to a child commit), so two contenders cannot both win.
// Releasing deletes it with `git push --force-with-lease=<ref>:<our commit>` from `cwd` (a
// checkout whose origin is the repo): the delete happens only while the ref is still ours, in
// one step, so a lock someone else took over is never removed.
export class LandingLock {
  constructor(gh, { ttlMin, cwd }) {
    this.gh = gh;
    this.ttlMin = ttlMin;
    this.cwd = cwd;
    this.commit = null;
  }

  route(suffix = '') { return `repos/${this.gh.repo}/git/${suffix}`; }

  makeCommit(tree, parent) {
    const r = this.gh.api('POST', this.route('commits'), {
      fields: { message: lockMessage({ ttl: this.ttlMin }), tree, 'parents[]': parent },
    });
    if (!r.ok || !r.data?.sha) throw new LandError(`could not create the lock commit (HTTP ${r.status})`);
    return r.data.sha;
  }

  // Returns { held: true } or { held: false, holder, stale }.
  // A 422 is contention only when a lock ref is there to read. With none, either the holder
  // released it between the create and the read (try again, a few times), or the create failed
  // for another reason (a token that cannot create refs, a protected name): that is an error to
  // fix, not a busy lock. Only the HTTP status is reported, never the API's own message.
  acquire({ baseSha, baseTree }) {
    for (let attempt = 1; ; attempt++) {
      const sha = this.makeCommit(baseTree, baseSha);
      const r = this.gh.api('POST', this.route('refs'), { fields: { ref: `refs/heads/${LOCK_REF}`, sha } });
      if (r.ok) { this.commit = sha; return { held: true }; }
      if (r.status !== 422) throw new LandError(`could not create the lock ref (HTTP ${r.status})`);
      const holder = this.read();
      if (holder) return { held: false, holder, stale: isStale(holder, this.ttlMin) };
      if (attempt >= 3) {
        throw new LandError(`could not create the landing lock ref (HTTP 422 with no lock present, ${attempt} tries): check that the GitHub token can create refs/heads/${LOCK_REF} in ${this.gh.repo}`);
      }
    }
  }

  // The current holder, or null when the lock is free.
  read() {
    const r = this.gh.api('GET', this.route(`ref/heads/${LOCK_REF}`));
    if (!r.ok) {
      if (r.status === 404) return null;
      throw new LandError(`could not read the lock ref (HTTP ${r.status})`);
    }
    const sha = r.data?.object?.sha;
    const c = this.gh.api('GET', this.route(`commits/${sha}`));
    if (!c.ok) throw new LandError(`could not read the lock commit (HTTP ${c.status})`);
    const info = parseLockMessage(c.data?.message);
    return { ...info, sha, tree: c.data?.tree?.sha, ageMin: Math.round(lockAgeMin(info)) };
  }

  // Move the ref from `fromSha` to a new child commit. Fails if anyone moved it meanwhile.
  advance(fromSha, tree) {
    const next = this.makeCommit(tree, fromSha);
    const r = this.gh.api('PATCH', this.route(`refs/heads/${LOCK_REF}`), { fields: { sha: next }, typed: { force: 'false' } });
    if (!r.ok) return false;
    this.commit = next;
    return true;
  }

  // False (lost) when anyone moved the ref, or the refresh could not be made.
  refresh() {
    if (!this.commit) return false;
    try {
      const c = this.gh.api('GET', this.route(`commits/${this.commit}`));
      return c.ok && this.advance(this.commit, c.data.tree.sha);
    } catch {
      return false;
    }
  }

  // The ref still points at our commit (checked after a gate and before every push and merge).
  stillHeld() {
    if (!this.commit) return false;
    const r = this.gh.api('GET', this.route(`ref/heads/${LOCK_REF}`));
    return r.ok && r.data?.object?.sha === this.commit;
  }

  reclaim(holder) {
    if (!holder?.sha || !holder.tree) return false;
    return this.advance(holder.sha, holder.tree);
  }

  // True when the lock is no longer ours (deleted, or another lander owns the ref now). False
  // when it could not be deleted and still points at our commit: `retained` then says why, and
  // the caller must report it (it blocks landers until deleted, or reclaimed as stale). The delete is
  // lock plumbing, not repo content, so it skips the repo's pre-push hook (--no-verify); every
  // push of PR content keeps the hooks.
  // Never release: a command started under the lock may still be running (see runCommands).
  keep(reason) { this.keepReason = reason; }

  release() {
    if (!this.commit) return true;
    const mine = this.commit;
    this.commit = null;
    this.retained = null;
    if (this.keepReason) {
      this.retained = { sha: mine, reason: `kept on purpose: ${this.keepReason}` };
      return false;
    }
    const r = git(['push', '--no-verify', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${LOCK_REF}:${mine}`, 'origin', `:refs/heads/${LOCK_REF}`], { cwd: this.cwd });
    if (r.status === 0) return true;
    let cur;
    try {
      const g = this.gh.api('GET', this.route(`ref/heads/${LOCK_REF}`));
      cur = g.ok ? g.data?.object?.sha : g.status === 404 ? null : mine;
    } catch {
      cur = mine;
    }
    if (cur !== mine) return true;
    this.retained = { sha: mine, reason: firstLine(r.stderr || r.stdout) || `git push exit ${r.status}` };
    return false;
  }
}

// What to tell the user when release() kept the lock.
export function retainedLockMessage(lock) {
  const remove = `git push --no-verify origin :refs/heads/${LOCK_REF}`;
  if (lock.keepReason) {
    return `the landing lock is kept because ${lock.keepReason}; stop that command's processes in the lander checkout first, then remove the lock with: ${remove}`;
  }
  return `the landing lock could not be released (${lock.retained?.reason}); it blocks every lander until it is deleted, or reclaimed as stale after its ttl (${lock.ttlMin} min); once no lander run is active, remove it with: ${remove}`;
}

export function baseTreeOf(cwd, ref) {
  return {
    baseSha: gitOk(['rev-parse', '--verify', `${ref}^{commit}`], { cwd }),
    baseTree: gitOk(['rev-parse', '--verify', `${ref}^{tree}`], { cwd }),
  };
}

// ---------------------------------------------------------------- PR body: ## Landing

const LANDING_RE = /^##[ \t]+Landing[ \t]*$/m;

function splitLanding(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const m = LANDING_RE.exec(text);
  if (!m) return { before: text, lines: [], after: '', found: false };
  const start = m.index;
  const rest = text.slice(start + m[0].length);
  const next = rest.search(/^##[ \t]+\S/m);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const after = next >= 0 ? rest.slice(next) : '';
  const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
  return { before: text.slice(0, start), lines, after, found: true };
}

function joinLanding({ before, lines, after }) {
  const head = before.replace(/\s+$/, '');
  const sec = `## Landing\n\n${lines.join('\n')}\n`;
  const tail = after ? `\n${after.replace(/^\s+/, '')}` : '';
  return `${head ? `${head}\n\n` : ''}${sec}${tail}`.replace(/\n{3,}/g, '\n\n');
}

const strip = (l) => l.replace(/^[-*][ \t]+/, '');

export function parseLanding(body) {
  const { lines } = splitLanding(body);
  const gates = [];
  const bounces = [];
  // `Gate: pending @ <sha>`: the lander rebased and gated <sha>, then started its push; it
  // becomes `pass` once the push is recorded (see land-queue landOne).
  const pending = [];
  let queuedAt = null;
  for (const raw of lines) {
    const l = strip(raw);
    let m;
    if ((m = l.match(/^Gate:\s*pass\s*@\s*([0-9a-f]{7,40})\b\s*(.*)$/i))) gates.push({ sha: m[1], note: m[2].replace(/^\(|\)$/g, '') });
    else if ((m = l.match(/^Gate:\s*pending\s*@\s*([0-9a-f]{40})\b/i))) pending.push(m[1]);
    else if ((m = l.match(/^Queued:\s*(\S+)/i))) queuedAt = m[1];
    else if ((m = l.match(/^Bounced:\s*(\S+)\s*(.*)$/i))) bounces.push({ at: m[1], reason: m[2] });
  }
  const text = String(body || '');
  const pm = text.match(/^[ \t]*(?:[-*][ \t]+)?Linear-Priority:[ \t]*([0-4])\b/im);
  let priority = pm ? Number(pm[1]) : DEFAULT_PRIORITY;
  if (priority === 0) priority = DEFAULT_PRIORITY; // Linear 0 = "no priority": treat as the default
  const dependsOn = [];
  for (const m of text.matchAll(/^[ \t]*(?:[-*][ \t]+)?Depends-on:[ \t]*(.+)$/gim)) {
    for (const d of m[1].matchAll(/#(\d+)/g)) dependsOn.push(Number(d[1]));
  }
  return { gates, gatedSha: gates.length ? gates[gates.length - 1].sha : null, pending, queuedAt, bounces, priority, dependsOn };
}

// Turn the lander's `Gate: pending @ <sha>` line into `Gate: pass @ <sha> (lander rebase)`.
export function confirmPending(body, sha) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  return text.split('\n').map((l) => (new RegExp(`^([-*][ \\t]+)?Gate:\\s*pending\\s*@\\s*${sha}\\b.*$`, 'i').test(l.trim())
    ? `- Gate: pass @ ${sha} (lander rebase)` : l)).join('\n');
}

// Write the section for a fresh enqueue by land-pr: one Gate line, Queued time, earlier bounces kept.
// Other lines in the section (Bounced:, Hold-By:, notes) are kept.
export function writeLanding(body, { gateSha, queuedAt }) {
  const parts = splitLanding(body);
  const rest = parts.lines.filter((l) => !/^(Gate|Queued):/i.test(strip(l)));
  parts.lines = [`- Gate: pass @ ${gateSha}`, `- Queued: ${queuedAt}`, ...rest];
  return joinLanding(parts);
}

// `Hold-By: <holder> <ISO time>` lines anywhere in the body record who set queue-hold.
// <holder> is `--holder <id>`, else $T3CODE_THREAD_ID. Nothing else is stable enough to release
// the hold with later (a shell's parent pid changes between calls), so without either it refuses.
const HOLD_LINE = /^[ \t]*(?:[-*][ \t]+)?Hold-By:[ \t]*(\S+)(?:[ \t]+(\S+))?[ \t]*$/i;

export function holderId(explicit) {
  const id = String(explicit || process.env.T3CODE_THREAD_ID || '').trim();
  if (!id) throw new LandError('pass --holder <id> (no $T3CODE_THREAD_ID here); use the same id for hold and --release-hold', 2);
  if (!/^\S+$/.test(id)) throw new LandError('a holder id has no spaces', 2);
  return id;
}

export function parseHolds(body) {
  const out = [];
  for (const l of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = l.match(HOLD_LINE);
    if (m) out.push({ holder: m[1], at: m[2] || null });
  }
  return out;
}

export function addHold(body, holder, at = new Date().toISOString()) {
  return appendLanding(body, `Hold-By: ${holder} ${at}`);
}

export function removeHold(body, holder) {
  return String(body || '').replace(/\r\n/g, '\n').split('\n')
    .filter((l) => { const m = l.match(HOLD_LINE); return !(m && m[1] === holder); })
    .join('\n');
}

export function appendLanding(body, line) {
  const parts = splitLanding(body);
  parts.lines.push(`- ${line}`);
  return joinLanding(parts);
}

// ---------------------------------------------------------------- queue order

// queue-next first, then Linear priority (1 urgent .. 4 low), then the time queued, then number.
export function orderQueue(prs) {
  const key = (pr) => {
    const l = parseLanding(pr.body);
    const t = Date.parse(l.queuedAt || pr.createdAt || '') || 0;
    return { next: labelNames(pr).includes('queue-next') ? 0 : 1, landing: labelNames(pr).includes('landing') ? 0 : 1, prio: l.priority, t };
  };
  return prs
    .map((pr) => ({ pr, k: key(pr) }))
    .sort((a, b) => a.k.landing - b.k.landing || a.k.next - b.k.next || a.k.prio - b.k.prio || a.k.t - b.k.t || a.pr.number - b.pr.number)
    .map((x) => x.pr);
}

// Open PRs labelled queued or landing (landing = a lander run stopped mid-PR), each once.
// All of them count for fairness (no merge-now while any is in line) and recovery.
export function listQueue(gh) {
  const seen = new Map();
  for (const label of ['landing', 'queued']) for (const pr of gh.prList(label)) seen.set(pr.number, pr);
  return [...seen.values()];
}

// The PRs that use up capacity (maxQueued): queued or landing and not held. A queue-hold PR
// cannot land, so it does not keep others waiting.
export function capacityUsed(prs) {
  return prs.filter((p) => !labelNames(p).includes('queue-hold')).length;
}

// PRs waiting for capacity, oldest first (time queued, then number).
export function listWaiting(gh) {
  const t = (pr) => Date.parse(parseLanding(pr.body).queuedAt || pr.createdAt || '') || 0;
  return gh.prList('queue-waiting')
    .filter((pr) => !labelNames(pr).some((l) => l === 'queued' || l === 'landing'))
    .sort((a, b) => t(a) - t(b) || a.number - b.number);
}

// Unmerged Depends-on PRs of `pr` (numbers).
export function unmetDeps(gh, pr) {
  return parseLanding(pr.body).dependsOn.filter((d) => {
    if (d === pr.number) return false;
    try { return gh.prView(d, 'number,state').state !== 'MERGED'; } catch { return true; }
  });
}

// Split the queue into eligible PRs (in order), held PRs, and PRs waiting on a dependency.
export function classifyQueue(gh, prs) {
  const held = [];
  const waiting = [];
  const eligible = [];
  // A PR made a draft after it was queued stays queued but is not landed until it is ready.
  const drafts = [];
  const depState = new Map();
  const depOpen = (n) => {
    if (!depState.has(n)) {
      let state = 'UNKNOWN';
      try { state = gh.prView(n, 'number,state').state; } catch { state = 'UNKNOWN'; }
      depState.set(n, state);
    }
    return depState.get(n) !== 'MERGED';
  };
  for (const pr of orderQueue(prs)) {
    if (labelNames(pr).includes('queue-hold')) { held.push(pr.number); continue; }
    if (pr.isDraft) { drafts.push(pr.number); continue; }
    const deps = parseLanding(pr.body).dependsOn.filter((d) => d !== pr.number && depOpen(d));
    if (deps.length) { waiting.push({ pr: pr.number, dependsOn: deps }); continue; }
    eligible.push(pr);
  }
  return { eligible, held, waiting, drafts };
}

// ---------------------------------------------------------------- merging

// The merge command: mergeCmd from repo.json (placeholders {pr} {sha} {method} {repo}), or
// gh pr merge pinned to the gated head. ghWrapper replaces gh for the merge only.
export function mergeArgv(cfg, { pr, sha, repo }) {
  if (cfg.mergeCmd) {
    return splitArgv(cfg.mergeCmd).map((t) => t
      .replaceAll('{pr}', String(pr)).replaceAll('{sha}', sha).replaceAll('{method}', cfg.mergeMethod).replaceAll('{repo}', repo));
  }
  const gh = cfg.ghWrapper ? splitArgv(cfg.ghWrapper) : ['gh'];
  return [...gh, 'pr', 'merge', String(pr), '--repo', repo, `--${cfg.mergeMethod}`, '--delete-branch', '--match-head-commit', sha];
}

// Runs from `cwd` (the repo's checkout), so a repo-relative mergeCmd or ghWrapper works from
// wherever the tool was started (land-queue --all).
export function mergePinned(gh, cfg, { pr, sha, cwd, lock = null }) {
  // `message` (the command's first output line, scrubbed) is for the local caller only; `summary`
  // has no command output and is what may go into a PR comment.
  const r = run(mergeArgv(cfg, { pr, sha, repo: gh.repo }), { env: gh.env, cwd });
  let after;
  if (r.status !== 0) {
    // A wrapper can merge and still exit non-zero (a failing step after the merge): a fresh read
    // that shows MERGED is a merge, cleaned up and counted. Anything else (or a failed read) stays
    // a failure; an unconfirmed or pending merge is never treated as merged.
    try { after = gh.prView(pr); } catch { after = null; }
    if (after?.state !== 'MERGED') return { ok: false, message: firstLine(r.stderr || r.stdout), summary: `merge command exit ${r.status}` };
  } else {
    after = waitForPr(gh, pr, (p) => p.state === 'MERGED');
  }
  if (after.state !== 'MERGED') {
    const s = `PR state is ${after.state} after the merge command`;
    return { ok: false, message: s, summary: s };
  }
  // The merge and its read-back take time: labels are cleared only while the lock is still ours
  // (a leftover label on a merged PR is cleared by the next lander).
  if (!lock || lock.stillHeld()) clearQueueLabels(gh, after);
  return { ok: true, mergeSha: after.mergeCommit?.oid || null };
}

// After a merge no queue label stays behind (best effort): the engine's teardown and the
// queue counts read them.
export function clearQueueLabels(gh, pr) {
  try { setLabels(gh, pr, { remove: ['landing', 'queued', 'queue-waiting', 'queue-next'] }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- the lander checkout

// <main checkout>-lander: a detached worktree created once and locked, so a sweep's plain
// `git worktree remove` (no --force) and `git worktree prune` both leave it alone. An existing
// one is used only when it is exactly that: its own top level, a registered worktree of this
// repository (same common git dir), and not a link or junction to the main checkout. Anything
// else at that path is refused before any fetch, reset, clean or push touches it.
// Ownership: the lander locks its checkout with LANDER_LOCK_REASON. A checkout locked that way
// is the lander's own, and resetting and cleaning it is safe. Any other registered worktree at
// that path (unlocked, or locked by someone else) is used only when it is detached and has no
// changes or untracked files; then an unlocked one is locked for the lander. Someone else's
// lock is never replaced, and a checkout holding work is refused with that work intact.
export const LANDER_LOCK_REASON = 'land-queue lander checkout';

export function landerCheckout(mainRoot, base) {
  const dir = `${mainRoot}-lander`;
  const mainCommon = canonKey(gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: mainRoot }));
  let exists = true;
  try { fs.lstatSync(dir); } catch { exists = false; }
  if (!exists) {
    // A new checkout starts on the PR's base, which may never have been fetched here. (An
    // existing path is verified first, before anything is fetched or touched.)
    fetchBranch(mainRoot, base);
    gitOk(['worktree', 'add', '--detach', dir, `refs/remotes/origin/${base}`], { cwd: mainRoot });
    gitOk(['worktree', 'lock', '--reason', LANDER_LOCK_REASON, dir], { cwd: mainRoot });
  }
  const entry = verifyLander(dir, mainRoot, mainCommon);
  const gitDir = gitOk(['rev-parse', '--absolute-git-dir'], { cwd: dir });
  const inProgress = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
    .filter((f) => fs.existsSync(path.join(gitDir, f)));
  if (entry.locked !== LANDER_LOCK_REASON) {
    const refuse = (why) => { throw new LandError(`refusing to use ${dir} as the lander checkout: ${why}; it was left untouched`); };
    if (entry.locked !== null) refuse(`it is locked by someone else (${entry.locked || 'no reason given'})`);
    if (!entry.detached) refuse('it has a branch checked out (the lander uses a detached checkout)');
    if (inProgress.length) refuse(`an operation is in progress there (${inProgress.join(', ')})`);
    // Ignored files count too: a reset to a commit that tracks the same path would overwrite them.
    const st = git(['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: dir });
    if (st.status !== 0) refuse('git status failed there');
    const lines = st.stdout.split(/\r?\n/).filter(Boolean);
    const ignored = lines.filter((l) => l.startsWith('!! ')).length;
    if (lines.length - ignored) refuse(`it has ${lines.length - ignored} changed or untracked file(s)`);
    if (ignored) refuse(`it has ${ignored} ignored file(s)`);
    gitOk(['worktree', 'lock', '--reason', LANDER_LOCK_REASON, dir], { cwd: mainRoot });
  } else if (inProgress.some((f) => f.startsWith('rebase-'))) {
    // The lander's own checkout: leave a half-finished rebase of an earlier run (either backend).
    git(['rebase', '--abort'], { cwd: dir });
  }
  return dir;
}

// The checkout's `git worktree list --porcelain` entry: { detached, locked } (locked: null when
// not locked, else the reason, '' without one). Throws when it is not the lander checkout.
function verifyLander(dir, mainRoot, mainCommon) {
  const refuse = (why) => { throw new LandError(`refusing to use ${dir} as the lander checkout: ${why}; move it away by hand`); };
  if (canonKey(dir) === canonKey(mainRoot)) refuse('it is the main checkout (a link or junction to it)');
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.status !== 0) refuse('it is not a git checkout');
  if (canonKey(top.stdout.trim()) !== canonKey(dir)) refuse('it is inside another checkout');
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  if (common.status !== 0 || canonKey(common.stdout.trim()) !== mainCommon) refuse('it belongs to another repository');
  const list = gitOk(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  for (const block of list.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt || canonKey(wt.slice('worktree '.length)) !== canonKey(dir)) continue;
    const locked = lines.find((l) => l === 'locked' || l.startsWith('locked '));
    return { detached: lines.includes('detached'), locked: locked === undefined ? null : locked.slice('locked'.length).trim() };
  }
  return refuse('it is not a registered worktree of this repository');
}

export function resetTo(dir, ref) {
  gitOk(['checkout', '--quiet', '--detach', '--force', ref], { cwd: dir });
  gitOk(['clean', '-fdq'], { cwd: dir });
}

// Repo commands (setup, gates, sweeps) never see the 1Password service-account token.
export const commandEnv = () => childEnv({ AGENT_LANDER: '1' });

// Run repo commands in order while refreshing the lock. Stops at the first failure; a refresh
// that fails means another lander may own the lock now: { ok: false, lost: true }.
// `entries` are { name, cmd } (name: the repo.json key and index, e.g. "affectedGate[0]").
// Returns { ok, lost, timedOut, name, cmd, status, summary }; `summary` is the only text about a
// failure that leaves here (name, command, exit status or timeout), never the command's output.
export async function runCommands(entries, dir, lock, cfg) {
  let lost = false;
  // A failed refresh means another lander may own the lock: the command is stopped at once.
  const onTick = () => { if (lock && !lock.refresh()) { lost = true; return false; } return true; };
  const limit = commandTimeoutMs(cfg);
  for (const { name, cmd } of entries) {
    const r = await runAsync(splitArgv(cmd), { cwd: dir, env: commandEnv(), tickMs: lock ? tickMs(cfg.lockTtlMin) : 0, onTick, timeoutMs: limit });
    const what = `${name} \`${cmd}\``;
    // A command can end before any refresh noticed a new owner: ownership is checked after each.
    if (!lost && lock && !lock.stillHeld()) lost = true;
    // The lock is someone else's now: nothing is kept or released for it, and since processes
    // this command started may survive, the checkout must not be reused (stuck).
    if (lost) return { ok: false, lost: true, stuck: Boolean(r.stuck), name, cmd, status: r.status, summary: `${what}: the landing lock was lost, so it was stopped` };
    if (r.stuck) {
      // Something it started may still run in the checkout: the lock must outlive it.
      const summary = `${what} timed out after ${Math.round(limit / 60000) || '<1'} min; its known processes were stopped, but one it started may still run, so the landing lock is kept`;
      if (lock) lock.keep(summary);
      return { ok: false, timedOut: true, stuck: true, name, cmd, status: r.status, summary };
    }
    if (r.status !== 0) return { ok: false, name, cmd, status: r.status, summary: `${what} exit ${r.status}` };
  }
  return { ok: true };
}

// [{ name: "key[i]", cmd }] for the commands of one repo.json key.
export function named(key, cmds) {
  return (Array.isArray(cmds) ? cmds : cmds ? [cmds] : []).map((cmd, i) => ({ name: `${key}[${i}]`, cmd }));
}

// The wide sweep's commands that do something: null, [], '' or blank entries leave none, and
// then there is no wide sweep (nothing can show the base is green).
export function sweepCommands(cfg) {
  return named('wideSweep', cfg.wideSweep).filter((e) => typeof e.cmd === 'string' && e.cmd.trim());
}

// Split every command a landing will run before anything is changed: one that cannot be run
// (shell syntax, an unbalanced quote) is a config error up front, not after a rebase or a push.
// gate: setup and affectedGate (the lander); merge: mergeCmd and ghWrapper. The wide sweep is
// left to the sweep, which reports its own failures.
export function validateLandingCommands(cfg, { gate = true, merge = true } = {}) {
  const lists = [];
  if (gate) lists.push(...named('setup', cfg.setup), ...named('affectedGate', cfg.affectedGate));
  if (merge) lists.push(...named('mergeCmd', cfg.mergeCmd), ...named('ghWrapper', cfg.ghWrapper));
  for (const { name, cmd } of lists) {
    try { procSplitArgv(cmd); } catch (e) { throw new LandError(`.agents/repo.json ${name} cannot be run: ${e.message}`, 2); }
  }
}

// ---------------------------------------------------------------- wide sweep

export function sweepState(repo) {
  return readJson(path.join(stateDir(), 'land-queue.json'), {})?.[repo] || {};
}

export function sweepDue(repo, cfg) {
  return sweepCommands(cfg).length > 0 && (sweepState(repo).sinceSweep || 0) >= cfg.sweepEveryMerges;
}

// Run the repo's wide sweep on its base in the lander checkout. The caller holds the landing
// lock. Red sets the repo pause. Returns { ok, cmd, status, lost }.
export async function runSweep({ cfg, mainRoot, lock }) {
  const dir = landerCheckout(mainRoot, cfg.base);
  fetchBranch(dir, cfg.base);
  resetTo(dir, `refs/remotes/origin/${cfg.base}`);
  const r = await runCommands([...named('setup', cfg.setup), ...sweepCommands(cfg)], dir, lock, cfg);
  // A command that could not be stopped may still use the checkout, and after a lost lock the
  // checkout may be another lander's: leave it as it is.
  if (r.stuck || r.lost) return r;
  // A sweep can finish before any refresh noticed another lander: ownership is checked before
  // the checkout is touched again.
  if (lock && !lock.stillHeld()) return { ...r, ok: false, lost: true, summary: 'the landing lock was lost' };
  resetTo(dir, `refs/remotes/origin/${cfg.base}`);
  return r;
}

// The sweep that is due after `sinceSweep` merges (call while holding the lock). Returns null
// when none is due, else { ran, ok, afterMerges, lost?, alert? }; a red sweep pauses the repo.
// The counter resets only when the sweep finished (green or red) while the lock was still ours:
// a sweep that throws (a checkout error, a bad command) or loses the lock stays due, so the next
// run tries it again; `lost` tells the caller to stop.
export async function dueSweep(ctx) {
  const { gh, cfg } = ctx;
  if (!sweepDue(gh.repo, cfg)) return null;
  const afterMerges = sweepState(gh.repo).sinceSweep || 0;
  const r = await runSweep(ctx);
  const out = { ran: true, ok: r.ok, afterMerges };
  if (r.lost) { out.ok = false; out.lost = true; out.alert = `wide sweep on ${cfg.base} stopped: the landing lock was lost; it stays due`; return out; }
  if (r.stuck) {
    // The caller stops; the lock is kept (runCommands) and the sweep stays due.
    out.stop = true;
    out.alert = `wide sweep on ${cfg.base}: ${r.summary}; it stays due`;
    return out;
  }
  if (r.ok) { markSwept(gh.repo); return out; }
  // Red: the pause must be recorded before the sweep counts as done. If it cannot be, the sweep
  // stays due and the caller stops: nothing more lands until a sweep runs again and a pause holds.
  try {
    gh.setPaused(true);
  } catch (e) {
    out.stop = true;
    out.alert = `wide sweep on ${cfg.base} failed after ${afterMerges} merges (${r.summary}) and the pause could not be set (${firstLine(e?.message || e)}); nothing more lands, and the sweep runs again first next time`;
    return out;
  }
  markSwept(gh.repo);
  out.paused = true;
  out.alert = `wide sweep on ${cfg.base} failed after ${afterMerges} merges (${r.summary}); the repo is paused (AGENT_LANDING_PAUSED=1). Open a ticket, fix ${cfg.base}, then run land-queue unpause.`;
  return out;
}

// ---------------------------------------------------------------- state (merge counts)

// ~/.agents/state, the same folder as the engine's repo registry (tests point HOME at a temp dir).
export function stateDir() {
  return path.join(homeDir(), '.agents', 'state');
}

// Merges per repo on this machine; `sinceSweep` drives the wide sweep every N merges.
// Read-modify-write under the ledger's lock file, so landers for two repos never lose a count.
function updateState(fn) {
  const file = path.join(stateDir(), 'land-queue.json');
  return withLock(file, () => {
    const s = readJson(file, {}) || {};
    const out = fn(s);
    writeJsonAtomic(file, s);
    return out;
  });
}

export function bumpMergeCount(repo) {
  return updateState((s) => {
    const cur = { merges: 0, sinceSweep: 0, ...(s[repo] || {}) };
    cur.merges += 1;
    cur.sinceSweep += 1;
    cur.lastMergeAt = new Date().toISOString();
    s[repo] = cur;
    return cur;
  });
}

export function markSwept(repo) {
  updateState((s) => { s[repo] = { ...(s[repo] || {}), sinceSweep: 0, lastSweepAt: new Date().toISOString() }; });
}

// Repos for --all: the engine's registry (~/.agents/state/repos.json), each root that still has
// an .agents/repo.json.
export function registeredRepos() {
  const roots = readRegistry().repos
    .map((r) => r && r.root)
    .filter((p) => typeof p === 'string' && fs.existsSync(path.join(p, '.agents', 'repo.json')))
    .map((p) => path.resolve(p));
  return [...new Set(roots)];
}

export function print(obj, json) {
  if (json) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else process.stdout.write(`${obj}\n`);
}
