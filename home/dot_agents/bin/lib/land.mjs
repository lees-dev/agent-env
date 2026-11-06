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
import { prepare, run as procRun, sleepMs, splitArgv as procSplitArgv } from './proc.mjs';
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

// Run asynchronously with stdin ignored, keeping only the last `tailLines` lines of output.
// onTick runs every tickMs while the child runs (used to refresh the landing lock).
export function runAsync(argv, { cwd, env = childEnv(), tailLines = 40, tickMs = 0, onTick } = {}) {
  return new Promise((resolve) => {
    let prepared;
    try { prepared = prepare(argv[0], argv.slice(1), { cwd, env }); } catch (e) { resolve({ status: 127, tail: [String(e.message)] }); return; }
    const [file, args, options] = prepared;
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    let partial = '';
    const take = (chunk) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) { tail.push(l); if (tail.length > tailLines) tail.shift(); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = tickMs > 0 && onTick ? setInterval(() => { try { onTick(); } catch { /* the caller's onTick records failures */ } }, tickMs) : null;
    child.on('error', (e) => { if (timer) clearInterval(timer); resolve({ status: 127, tail: [String(e.message)] }); });
    child.on('close', (code) => {
      if (timer) clearInterval(timer);
      if (partial) { tail.push(partial); if (tail.length > tailLines) tail.shift(); }
      resolve({ status: code ?? 1, tail });
    });
  });
}

export function pollMs() {
  const v = Number(process.env.AGENT_LAND_POLL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

// How often the lock is refreshed while a repo command runs: a third of its ttl, at least a
// minute (AGENT_LAND_TICK_MS overrides it for tests).
export function tickMs(ttlMin) {
  const v = Number(process.env.AGENT_LAND_TICK_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return Math.max(60000, Math.floor((ttlMin * 60000) / 3));
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
  cfg.lockTtlMin = num(cfg.lockTtlMin, 45);
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

export const PR_FIELDS = 'number,title,state,isDraft,headRefName,headRefOid,baseRefName,labels,body,createdAt,mergeCommit,url';

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
  acquire({ baseSha, baseTree }) {
    const sha = this.makeCommit(baseTree, baseSha);
    const r = this.gh.api('POST', this.route('refs'), { fields: { ref: `refs/heads/${LOCK_REF}`, sha } });
    if (r.ok) { this.commit = sha; return { held: true }; }
    if (r.status !== 422) throw new LandError(`could not create the lock ref (HTTP ${r.status})`);
    const holder = this.read();
    return { held: false, holder, stale: holder ? isStale(holder, this.ttlMin) : false };
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

  release() {
    if (!this.commit) return false;
    const mine = this.commit;
    this.commit = null;
    const r = git(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${LOCK_REF}:${mine}`, 'origin', `:refs/heads/${LOCK_REF}`], { cwd: this.cwd });
    return r.status === 0;
  }
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
  let queuedAt = null;
  for (const raw of lines) {
    const l = strip(raw);
    let m;
    if ((m = l.match(/^Gate:\s*pass\s*@\s*([0-9a-f]{7,40})\b\s*(.*)$/i))) gates.push({ sha: m[1], note: m[2].replace(/^\(|\)$/g, '') });
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
  return { gates, gatedSha: gates.length ? gates[gates.length - 1].sha : null, queuedAt, bounces, priority, dependsOn };
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
    const deps = parseLanding(pr.body).dependsOn.filter((d) => d !== pr.number && depOpen(d));
    if (deps.length) { waiting.push({ pr: pr.number, dependsOn: deps }); continue; }
    eligible.push(pr);
  }
  return { eligible, held, waiting };
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
export function mergePinned(gh, cfg, { pr, sha, cwd }) {
  const r = run(mergeArgv(cfg, { pr, sha, repo: gh.repo }), { env: gh.env, cwd });
  if (r.status !== 0) return { ok: false, message: firstLine(r.stderr || r.stdout) };
  const after = waitForPr(gh, pr, (p) => p.state === 'MERGED');
  if (after.state !== 'MERGED') return { ok: false, message: `PR state is ${after.state} after the merge command` };
  clearQueueLabels(gh, after);
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
export function landerCheckout(mainRoot, base) {
  const dir = `${mainRoot}-lander`;
  const mainCommon = canonKey(gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: mainRoot }));
  let exists = true;
  try { fs.lstatSync(dir); } catch { exists = false; }
  if (!exists) gitOk(['worktree', 'add', '--detach', dir, `refs/remotes/origin/${base}`], { cwd: mainRoot });
  verifyLander(dir, mainRoot, mainCommon);
  const lock = git(['worktree', 'lock', '--reason', 'land-queue lander checkout', dir], { cwd: mainRoot });
  if (lock.status !== 0 && !/already locked/i.test(lock.stderr)) throw new LandError(`git worktree lock failed: ${firstLine(lock.stderr)}`);
  // Leave any earlier half-finished rebase.
  if (fs.existsSync(path.join(gitOk(['rev-parse', '--absolute-git-dir'], { cwd: dir }), 'rebase-merge'))) git(['rebase', '--abort'], { cwd: dir });
  return dir;
}

function verifyLander(dir, mainRoot, mainCommon) {
  const refuse = (why) => { throw new LandError(`refusing to use ${dir} as the lander checkout: ${why}; move it away by hand`); };
  if (canonKey(dir) === canonKey(mainRoot)) refuse('it is the main checkout (a link or junction to it)');
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.status !== 0) refuse('it is not a git checkout');
  if (canonKey(top.stdout.trim()) !== canonKey(dir)) refuse('it is inside another checkout');
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  if (common.status !== 0 || canonKey(common.stdout.trim()) !== mainCommon) refuse('it belongs to another repository');
  const list = gitOk(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  const registered = list.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).some((l) => canonKey(l.slice('worktree '.length)) === canonKey(dir));
  if (!registered) refuse('it is not a registered worktree of this repository');
}

export function resetTo(dir, ref) {
  gitOk(['checkout', '--quiet', '--detach', '--force', ref], { cwd: dir });
  gitOk(['clean', '-fdq'], { cwd: dir });
}

// Repo commands (setup, gates, sweeps) never see the 1Password service-account token.
export const commandEnv = () => childEnv({ AGENT_LANDER: '1' });

// Run repo commands in order while refreshing the lock. Stops at the first failure; a refresh
// that fails means another lander may own the lock now: { ok: false, lost: true }.
export async function runCommands(cmds, dir, lock, ttlMin) {
  let lost = false;
  const onTick = () => { if (lock && !lock.refresh()) lost = true; };
  for (const c of cmds) {
    const r = await runAsync(splitArgv(c), { cwd: dir, env: commandEnv(), tickMs: lock ? tickMs(ttlMin) : 0, onTick });
    if (lost) return { ok: false, lost: true, cmd: c, status: r.status, tail: r.tail };
    if (r.status !== 0) return { ok: false, cmd: c, status: r.status, tail: r.tail };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- wide sweep

export function sweepState(repo) {
  return readJson(path.join(stateDir(), 'land-queue.json'), {})?.[repo] || {};
}

export function sweepDue(repo, cfg) {
  return Boolean(cfg.wideSweep) && (sweepState(repo).sinceSweep || 0) >= cfg.sweepEveryMerges;
}

// Run the repo's wide sweep on its base in the lander checkout. The caller holds the landing
// lock. Red sets the repo pause. Returns { ok, cmd, status, lost }.
export async function runSweep({ cfg, mainRoot, lock }) {
  const dir = landerCheckout(mainRoot, cfg.base);
  fetchBranch(dir, cfg.base);
  resetTo(dir, `refs/remotes/origin/${cfg.base}`);
  const cmds = Array.isArray(cfg.wideSweep) ? cfg.wideSweep : [cfg.wideSweep];
  const r = await runCommands([...cfg.setup, ...cmds], dir, lock, cfg.lockTtlMin);
  resetTo(dir, `refs/remotes/origin/${cfg.base}`);
  return r;
}

// The sweep that is due after `sinceSweep` merges (call while holding the lock). Returns null
// when none is due, else { ran, ok, afterMerges, alert? }; a red sweep pauses the repo.
export async function dueSweep(ctx) {
  const { gh, cfg } = ctx;
  if (!sweepDue(gh.repo, cfg)) return null;
  const afterMerges = sweepState(gh.repo).sinceSweep || 0;
  markSwept(gh.repo);
  const r = await runSweep(ctx);
  const out = { ran: true, ok: r.ok, afterMerges };
  if (r.ok) return out;
  if (r.lost) { out.alert = `wide sweep on ${cfg.base} stopped: the landing lock was lost`; return out; }
  gh.setPaused(true);
  out.paused = true;
  out.alert = `wide sweep on ${cfg.base} failed after ${afterMerges} merges (\`${r.cmd}\` exit ${r.status}); the repo is paused (AGENT_LANDING_PAUSED=1). Open a ticket, fix ${cfg.base}, then run land-queue unpause.`;
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
