// Shared helpers for land-pr.mjs and land-queue.mjs (the local land queue).
// Node >= 22, ESM, no dependencies. Every child process runs with shell: false and an
// explicit stdin. Output is counts, PR numbers, SHAs and labels; never a secret value.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
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

export const DEFAULT_CONFIG = {
  base: 'main',
  setup: [],
  gate: [],
  affectedGate: null,
  mergeMethod: 'squash',
  mergeCmd: null,
  ghWrapper: null,
  sweepEveryMerges: 5,
  wideSweep: null,
  lockTtlMin: 45,
  maxQueued: MAX_QUEUED,
};

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

// ---------------------------------------------------------------- argv strings

// Split a command string into argv without a shell. Quotes group words; a backslash escapes
// only a double quote or a backslash before a double quote, so Windows paths stay intact.
export function splitArgv(str) {
  if (Array.isArray(str)) return str.slice();
  const out = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && str[i + 1] === '"') { cur += '"'; i++; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (/\s/.test(c)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quote) throw new LandError(`unbalanced quote in command: ${str}`, 2);
  if (inWord) out.push(cur);
  return out.map(expandHome);
}

export function expandHome(token) {
  const home = os.homedir();
  if (token === '~') return home;
  if (token.startsWith('~/') || token.startsWith('~\\')) return path.join(home, token.slice(2));
  if (token.startsWith('$HOME/') || token.startsWith('$HOME\\')) return path.join(home, token.slice(6));
  return token;
}

// ---------------------------------------------------------------- process spawning

function envPath(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] || '' : '';
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Resolve a command name to a file. Windows: .exe, .com, .cmd, .bat, then .mjs (a Node shim).
// Elsewhere: the bare name, then .mjs.
export function resolveCommand(name, env = process.env) {
  const exts = IS_WIN ? ['.exe', '.com', '.cmd', '.bat', '.mjs'] : ['', '.mjs'];
  const hasDir = name.includes('/') || (IS_WIN && name.includes('\\'));
  const tryBase = (base) => {
    if (path.extname(base) && isFile(base)) return base;
    for (const e of exts) if (isFile(base + e)) return base + e;
    return null;
  };
  if (hasDir || path.isAbsolute(name)) return tryBase(path.resolve(name));
  for (const dir of envPath(env).split(path.delimiter)) {
    if (!dir) continue;
    const hit = tryBase(path.join(dir.replace(/^"|"$/g, ''), name));
    if (hit) return hit;
  }
  return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdEscapeArg(arg) {
  let a = `${arg}`;
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  return a.replace(CMD_META, '^$1');
}

// Turn [cmd, ...args] into what spawn needs, without a shell.
export function prepareSpawn(argv, env = process.env) {
  const [cmd, ...args] = argv;
  const file = resolveCommand(cmd, env);
  if (!file) throw new LandError(`command not found on PATH: ${cmd}`, 127);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.js') return { file: process.execPath, args: [file, ...args], opts: {} };
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const line = [file.replace(CMD_META, '^$1'), ...args.map(cmdEscapeArg)].join(' ');
    return {
      file: process.env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      opts: { windowsVerbatimArguments: true },
    };
  }
  return { file, args, opts: {} };
}

// Run synchronously. stdin is the given input or empty (never inherited).
export function run(argv, { cwd, env = process.env, input = '', timeoutMs } = {}) {
  const p = prepareSpawn(argv, env);
  const r = spawnSync(p.file, p.args, {
    ...p.opts,
    cwd,
    env,
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message || r.error) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Run asynchronously with stdin ignored, keeping only the last `tailLines` lines of output.
// onTick runs every tickMs while the child runs (used to refresh the landing lock).
export function runAsync(argv, { cwd, env = process.env, tailLines = 40, tickMs = 0, onTick } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = prepareSpawn(argv, env); } catch (e) { resolve({ status: 127, tail: [String(e.message)] }); return; }
    const child = spawn(p.file, p.args, { ...p.opts, cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    let partial = '';
    const take = (chunk) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) { tail.push(l); if (tail.length > tailLines) tail.shift(); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = tickMs > 0 && onTick ? setInterval(() => { try { onTick(); } catch { /* reported by the caller */ } }, tickMs) : null;
    child.on('error', (e) => { if (timer) clearInterval(timer); resolve({ status: 127, tail: [String(e.message)] }); });
    child.on('close', (code) => {
      if (timer) clearInterval(timer);
      if (partial) { tail.push(partial); if (tail.length > tailLines) tail.shift(); }
      resolve({ status: code ?? 1, tail });
    });
  });
}

export function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pollMs() {
  const v = Number(process.env.AGENT_LAND_POLL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
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

export function repoTop(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  if (r.status !== 0) throw new LandError('not inside a git checkout', 2);
  return path.resolve(r.stdout.trim());
}

// The main checkout of the repository that `cwd` belongs to (worktrees share its common dir).
export function mainCheckout(cwd) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.status !== 0) throw new LandError('not inside a git checkout', 2);
  const common = path.resolve(r.stdout.trim());
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

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

export function loadRepoConfig(root) {
  const file = path.join(root, '.agents', 'repo.json');
  let raw = {};
  let found = false;
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); found = true; } catch (e) {
      throw new LandError(`.agents/repo.json does not parse: ${e.message}`, 2);
    }
  }
  const cfg = { ...DEFAULT_CONFIG, ...raw, found };
  for (const k of ['setup', 'gate']) cfg[k] = Array.isArray(cfg[k]) ? cfg[k] : [];
  if (!Array.isArray(cfg.affectedGate) || cfg.affectedGate.length === 0) cfg.affectedGate = cfg.gate;
  if (!['squash', 'merge', 'rebase'].includes(cfg.mergeMethod)) throw new LandError(`mergeMethod must be squash, merge or rebase`, 2);
  cfg.lockTtlMin = Number(cfg.lockTtlMin) > 0 ? Number(cfg.lockTtlMin) : DEFAULT_CONFIG.lockTtlMin;
  cfg.maxQueued = Number(cfg.maxQueued) > 0 ? Number(cfg.maxQueued) : MAX_QUEUED;
  cfg.sweepEveryMerges = Number(cfg.sweepEveryMerges) > 0 ? Number(cfg.sweepEveryMerges) : DEFAULT_CONFIG.sweepEveryMerges;
  for (const k of ['setup', 'gate', 'affectedGate']) {
    if (cfg[k].some((c) => typeof c !== 'string' || /TODO\(repo-defaults\)/.test(c))) {
      throw new LandError(`.agents/repo.json ${k} still has a TODO(repo-defaults) or a non-string entry`, 2);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------- gh

export class Gh {
  constructor({ repo, wrapper = null, env = process.env }) {
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
export class LandingLock {
  constructor(gh, { ttlMin }) {
    this.gh = gh;
    this.ttlMin = ttlMin;
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

  refresh() {
    if (!this.commit) return false;
    const c = this.gh.api('GET', this.route(`commits/${this.commit}`));
    return c.ok && this.advance(this.commit, c.data.tree.sha);
  }

  reclaim(holder) {
    if (!holder?.sha || !holder.tree) return false;
    return this.advance(holder.sha, holder.tree);
  }

  release() {
    if (!this.commit) return false;
    const cur = this.gh.api('GET', this.route(`ref/heads/${LOCK_REF}`));
    const mine = cur.ok && cur.data?.object?.sha === this.commit;
    this.commit = null;
    if (!mine) return false;
    const r = this.gh.api('DELETE', this.route(`refs/heads/${LOCK_REF}`));
    return r.ok;
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
export function writeLanding(body, { gateSha, queuedAt }) {
  const parts = splitLanding(body);
  const bounces = parts.lines.filter((l) => /^Bounced:/i.test(strip(l)));
  parts.lines = [`- Gate: pass @ ${gateSha}`, `- Queued: ${queuedAt}`, ...bounces];
  return joinLanding(parts);
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
// These count toward the repo's capacity (maxQueued); queue-blocked, queue-hold and
// queue-waiting do not.
export function listQueue(gh) {
  const seen = new Map();
  for (const label of ['landing', 'queued']) for (const pr of gh.prList(label)) seen.set(pr.number, pr);
  return [...seen.values()];
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

export function mergePinned(gh, cfg, { pr, sha }) {
  const r = run(mergeArgv(cfg, { pr, sha, repo: gh.repo }), { env: gh.env });
  if (r.status !== 0) return { ok: false, message: firstLine(r.stderr || r.stdout) };
  const after = waitForPr(gh, pr, (p) => p.state === 'MERGED');
  if (after.state !== 'MERGED') return { ok: false, message: `PR state is ${after.state} after the merge command` };
  return { ok: true, mergeSha: after.mergeCommit?.oid || null };
}

// ---------------------------------------------------------------- state (merge counts)

export function stateDir() {
  return process.env.AGENT_LAND_STATE_DIR || path.join(os.homedir(), '.agents', 'state');
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Merges per repo on this machine; `sinceSweep` drives the wide sweep every N merges.
export function bumpMergeCount(repo) {
  const file = path.join(stateDir(), 'land-queue.json');
  const s = readJson(file, {});
  const cur = { merges: 0, sinceSweep: 0, ...(s[repo] || {}) };
  cur.merges += 1;
  cur.sinceSweep += 1;
  cur.lastMergeAt = new Date().toISOString();
  s[repo] = cur;
  writeJsonAtomic(file, s);
  return cur;
}

export function markSwept(repo) {
  const file = path.join(stateDir(), 'land-queue.json');
  const s = readJson(file, {});
  s[repo] = { ...(s[repo] || {}), sinceSweep: 0, lastSweepAt: new Date().toISOString() };
  writeJsonAtomic(file, s);
}

// Repos for --all: ~/.agents/state/repos.json, tolerant of the shapes the engine may write:
// ["<path>", ...], {"repos": [...]}, or {"<name>": "<path>" | {repoRoot|root|path}}.
export function registeredRepos() {
  const file = path.join(stateDir(), 'repos.json');
  const data = readJson(file, null);
  if (!data) return [];
  const list = Array.isArray(data) ? data : Array.isArray(data.repos) ? data.repos : Object.values(data);
  const roots = [];
  for (const e of list) {
    const p = typeof e === 'string' ? e : e && (e.repoRoot || e.root || e.path);
    if (typeof p === 'string' && fs.existsSync(path.join(p, '.agents', 'repo.json'))) roots.push(path.resolve(p));
  }
  return [...new Set(roots)];
}

export function print(obj, json) {
  if (json) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else process.stdout.write(`${obj}\n`);
}
