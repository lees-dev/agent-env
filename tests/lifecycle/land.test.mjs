// Tests for home/dot_agents/bin/land-pr.mjs, land-queue.mjs and lib/land.mjs.
// Run: node --test "tests/lifecycle/*.test.mjs"
// Git is real (local bare "origin" plus a clone); gh is fakes/fake-gh.mjs on PATH (a .cmd shim on
// Windows, a sh shim elsewhere, so commands go through lib/proc.mjs as real ones do), backed by
// the same bare repo. Every temp path contains spaces, to cover Windows paths with spaces.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendLanding, confirmPending, git as landGit, isStale, lockMessage, orderQueue, parseHolds, parseLanding, runAsync,
  parseLockMessage, rangeDiffChanges, registeredRepos, scrub, splitArgv, writeLanding,
} from '../../home/dot_agents/bin/lib/land.mjs';
// Through the namespace, so an older land.mjs without them fails only the tests that use them.
import * as landLib from '../../home/dot_agents/bin/lib/land.mjs';
const setLockTtl = (m) => landLib.setLockTtl(m);
const ioTimeoutMs = () => landLib.ioTimeoutMs();
const netTimeoutMs = () => landLib.netTimeoutMs();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../home/dot_agents/bin');
const LAND_PR = path.join(BIN, 'land-pr.mjs');
const LAND_QUEUE = path.join(BIN, 'land-queue.mjs');
const temps = [];
// A process a test proved unstoppable (a hook's sleep on Windows) may still hold a file for a
// moment: cleanup is best effort, never a test failure.
after(() => { for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS temp cleanup */ } } });

// gh on PATH: the same shim shape as the lifecycle fakes (helpers.mjs installFake).
function installGh(dir) {
  const fake = path.join(HERE, 'fakes', 'fake-gh.mjs');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'gh.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    const f = path.join(dir, 'gh');
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
}

function pathKey(env) { return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'; }

function sh(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// The gate: counts its runs, fails when the control file says so or when it can see the
// 1Password token, and can change the fake GitHub mid-landing (LAND_TEST_GATE_ACTION):
// hold, pause, move (push to the PR branch), dep (add an unmerged Depends-on), retarget (base
// becomes "other"), steal (another lander replaces the landing lock; its sha goes to <gate>.stolen); several
// actions join with + (steal+draft:1).
// LAND_TEST_GATE_SLEEP_MS keeps it running (for the lock refresh ticks). It always prints a
// secret-shaped line that no scrub pattern matches (it must never reach a PR comment).
// LAND_TEST_GATE_HANG=1 starts a child that sleeps for ten minutes (its pid goes to
// <gate>.child) and then never exits itself.
const GATE = `import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const f = process.env.LAND_TEST_GATE;
if (f) fs.appendFileSync(f + '.runs', 'x');
console.log('debug: config value plainword-SHOULD-NOT-LEAK-7f3a');
if (process.env.OP_SERVICE_ACCOUNT_TOKEN) { console.log('token leaked into the gate'); process.exit(1); }
if (process.env.LAND_TEST_GATE_HANG === 'orphan') {
  // An intermediate child starts a detached worker (cwd outside the checkout) and exits at once:
  // by the timeout the worker is no longer linked to the gate at all.
  const worker = 'setTimeout(() => {}, 600000)';
  const mid = "const {spawn}=require('node:child_process');const fs=require('node:fs');const w=spawn(process.execPath,['-e'," + JSON.stringify(worker) + "],{cwd:require('node:os').tmpdir(),detached:true,stdio:'ignore'});w.unref();fs.writeFileSync(process.argv[1],String(w.pid));";
  spawn(process.execPath, ['-e', mid, f + '.child'], { stdio: 'ignore' });
  fs.writeFileSync(f + '.self', String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.env.LAND_TEST_GATE_HANG) {
  // =detached: the child gets its own session/process group (it escapes a group kill).
  const detached = process.env.LAND_TEST_GATE_HANG === 'detached';
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached });
  if (detached) c.unref();
  fs.writeFileSync(f + '.child', String(c.pid));
  fs.writeFileSync(f + '.self', String(process.pid));
  setInterval(() => {}, 1000);
} else {
const g = (...a) => spawnSync('git', ['-C', process.env.FAKE_GH_BARE, ...a], { encoding: 'utf8' }).stdout.trim();
const [act, n] = (process.env.LAND_TEST_GATE_ACTION || '').split(':');
const acts = (act || '').split('+');
if (act) {
  const sf = process.env.FAKE_GH_STATE;
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const pr = s.prs.find((p) => p.number === Number(n));
  if (acts.includes('hold')) pr.labels.push('queue-hold');
  if (acts.includes('pause')) s.variables = { ...(s.variables || {}), AGENT_LANDING_PAUSED: '1' };
  if (acts.includes('dep')) pr.body += '\\nDepends-on: #99\\n';
  if (acts.includes('retarget')) pr.baseRefName = 'other';
  if (acts.includes('draft')) pr.isDraft = true;
  if (acts.includes('move')) {
    const ref = 'refs/heads/' + pr.headRefName;
    const c = g('commit-tree', g('rev-parse', ref + '^{tree}'), '-p', g('rev-parse', ref), '-m', 'moved');
    g('update-ref', ref, c);
  }
  if (acts.includes('steal')) {
    const lock = 'refs/heads/agent-landing-lock';
    const c = g('commit-tree', g('rev-parse', lock + '^{tree}'), '-m', 'agent-landing-lock host=other pid=1 at=' + new Date().toISOString() + ' ttl=45');
    g('update-ref', lock, c);
    fs.writeFileSync(f + '.stolen', c);
  }
  fs.writeFileSync(sf, JSON.stringify(s, null, 2));
}
const wait = Number(process.env.LAND_TEST_GATE_SLEEP_MS || 0);
if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
process.exit(f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('fail') ? 1 : 0);
}
`;
// The wide sweep: LAND_TEST_SWEEP=fail exits 1; =steal replaces the landing lock (another
// lander) and exits 0 at once, before any lock refresh.
const SWEEP = `import { spawnSync } from 'node:child_process';
if (process.env.LAND_TEST_SWEEP === 'steal') {
  const g = (...a) => spawnSync('git', ['-C', process.env.FAKE_GH_BARE, ...a], { encoding: 'utf8' }).stdout.trim();
  const lock = 'refs/heads/agent-landing-lock';
  g('update-ref', lock, g('commit-tree', g('rev-parse', lock + '^{tree}'), '-m', 'agent-landing-lock host=other pid=1 at=' + new Date().toISOString() + ' ttl=45'));
}
if (process.env.LAND_TEST_SWEEP === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
process.exit(process.env.LAND_TEST_SWEEP === 'fail' ? 1 : 0);
`;

function setup(repoJson = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land test '));
  temps.push(tmp);
  const bare = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'my repo');
  const fakebin = path.join(tmp, 'fake bin');
  fs.mkdirSync(fakebin);
  installGh(fakebin);
  const home = path.join(tmp, 'home dir');
  fs.mkdirSync(home);
  const stateFile = path.join(tmp, 'gh state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ prs: [], labels: [], comments: [], calls: [] }));
  const gitcfg = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitcfg, '');
  const env = { ...process.env };
  // No inherited GIT_* (an outer git's GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE, such as in a
  // hook) reaches the fixture's git; its own GIT_* settings are added below.
  for (const k of Object.keys(env)) if (/^(OP_|GIT_)/i.test(k) || k.toUpperCase() === 'T3CODE_THREAD_ID') delete env[k];
  env.OP_SERVICE_ACCOUNT_TOKEN = 'dummy-test-value';
  const pk = pathKey(env);
  env[pk] = `${fakebin}${path.delimiter}${env[pk] || ''}`;
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    FAKE_GH_STATE: stateFile, FAKE_GH_BARE: bare, HOME: home, USERPROFILE: home, AGENT_LAND_POLL_MS: '1',
    LAND_TEST_GATE: path.join(tmp, 'gate result'),
    // The test mode, and the bare origin declared as standing for github.com/o/r: the tools still
    // check origin's push URL against it (an undeclared or other destination is refused).
    AGENT_ENV_NO_SECRETS: '1', AGENT_LAND_TEST_FAKE_GITHUB: `o/r=${bare}`,
  });
  sh(tmp, env, 'init', '--quiet', '--bare', '-b', 'main', bare);
  sh(tmp, env, 'clone', '--quiet', bare, work);
  fs.mkdirSync(path.join(work, '.agents'));
  fs.mkdirSync(path.join(work, 'scripts'));
  fs.writeFileSync(path.join(work, '.agents', 'repo.json'), JSON.stringify({
    version: 1, repo: 'r', base: 'main', vault: 'agent-repos', setup: [], gate: ['node scripts/gate.mjs'],
    affectedGate: ['node scripts/gate.mjs'], mergeMethod: 'squash', sweepEveryMerges: 5, wideSweep: null, lockTtlMin: 45, ...repoJson,
  }, null, 2));
  fs.writeFileSync(path.join(work, 'scripts', 'gate.mjs'), GATE);
  fs.writeFileSync(path.join(work, 'scripts', 'sweep.mjs'), SWEEP);
  fs.writeFileSync(path.join(work, 'README.md'), 'line one\nline two\nline three\n');
  sh(work, env, 'add', '-A');
  sh(work, env, 'commit', '--quiet', '-m', 'initial');
  sh(work, env, 'push', '--quiet', 'origin', 'HEAD:main');
  return { tmp, bare, work, env, stateFile, home };
}

const state = (t) => JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
const saveState = (t, s) => fs.writeFileSync(t.stateFile, JSON.stringify(s, null, 2));
const prOf = (t, n) => state(t).prs.find((p) => p.number === n);

// Make a branch from origin/main with one commit, push it and register PR n.
function makePr(t, n, { file = `f${n}.txt`, content = `pr ${n}\n`, labels = [], body = '', priority, base = 'main' } = {}) {
  const branch = `agent/LEE-${n}-change`;
  sh(t.work, t.env, 'fetch', '--quiet', 'origin');
  sh(t.work, t.env, 'checkout', '--quiet', '-B', branch, `origin/${base}`);
  fs.writeFileSync(path.join(t.work, file), content);
  sh(t.work, t.env, 'add', '-A');
  sh(t.work, t.env, 'commit', '--quiet', '-m', `change ${n}`);
  sh(t.work, t.env, 'push', '--quiet', '-f', 'origin', `HEAD:refs/heads/${branch}`);
  const head = sh(t.work, t.env, 'rev-parse', 'HEAD');
  const s = state(t);
  const b = priority === undefined ? body : `${body}\nLinear-Priority: ${priority}\n`;
  s.prs.push({ number: n, title: `Change ${n}`, headRefName: branch, baseRefName: base, state: 'OPEN', labels, body: b, createdAt: `2026-11-0${Math.min(n, 9)}T00:00:00Z` });
  saveState(t, s);
  return head;
}

function queuePr(t, n, opts = {}) {
  const head = makePr(t, n, opts);
  const s = state(t);
  const p = s.prs.find((x) => x.number === n);
  p.labels = [...new Set(['queued', ...(opts.labels || [])])];
  p.body = writeLanding(p.body, { gateSha: head, queuedAt: opts.queuedAt || `2026-11-06T0${n}:00:00Z`, base: opts.base || 'main' });
  saveState(t, s);
  return head;
}

function advanceMain(t, file, content) {
  sh(t.work, t.env, 'fetch', '--quiet', 'origin');
  sh(t.work, t.env, 'checkout', '--quiet', '-B', 'tmp-main', 'origin/main');
  fs.writeFileSync(path.join(t.work, file), content);
  sh(t.work, t.env, 'add', '-A');
  sh(t.work, t.env, 'commit', '--quiet', '-m', `main ${file}`);
  sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:main');
}

function setLock(t, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const tree = sh(t.bare, t.env, 'rev-parse', 'main^{tree}');
  const sha = sh(t.bare, t.env, 'commit-tree', tree, '-p', 'main', '-m', lockMessage({ host: 'other-host', pid: 4242, at, ttl: 45 }));
  sh(t.bare, t.env, 'update-ref', 'refs/heads/agent-landing-lock', sha);
}

const lockExists = (t) => spawnSync('git', ['-C', t.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/agent-landing-lock'], { env: t.env }).status === 0;

function tool(t, script, ...args) {
  // A hung tool fails its test after five minutes instead of stalling the suite.
  const r = spawnSync(process.execPath, [script, ...args], { cwd: t.cwd || t.work, env: t.env, encoding: 'utf8', shell: false, timeout: 300000 });
  if (r.error) return { status: null, out: '', err: String(r.error.message) };
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const lockSha = (t) => spawnSync('git', ['-C', t.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/agent-landing-lock'], { env: t.env, encoding: 'utf8' }).stdout.trim();

function runQueue(t, ...extra) {
  const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json', ...extra);
  assert.equal(r.status, 0, r.err || r.out);
  return JSON.parse(r.out);
}

// ------------------------------------------------------------------------- unit

// git for the standalone tests below: no inherited GIT_* (a hook's GIT_DIR would point every
// call at an outer repo) and an empty config of its own (no user insteadOf or hooks).
function isolatedGitEnv(tmp, extra = {}) {
  const cfg = path.join(tmp, 'gitconfig');
  fs.writeFileSync(cfg, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return { ...env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}
// In-process calls (pushTarget, git) read process.env: run fn with it set to env, then put the
// original back. Tests in one file run one after another, so nothing else sees the change.
function withProcessEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('lib/land.mjs', () => {
  // The standalone git tests run inside a hook-like environment (GIT_DIR and GIT_INDEX_FILE of an
  // outer repo): that repo's config and index stay byte for byte the same.
  test('standalone git tests leave an outer repo alone (inherited GIT_DIR / GIT_INDEX_FILE)', { timeout: 180000 }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land outer '));
    temps.push(tmp);
    const outer = path.join(tmp, 'outer');
    const env = isolatedGitEnv(tmp);
    spawnSync('git', ['init', '--quiet', outer], { env });
    fs.writeFileSync(path.join(outer, 'f.txt'), 'x\n');
    spawnSync('git', ['-C', outer, 'add', 'f.txt'], { env });
    const bytes = () => [fs.readFileSync(path.join(outer, '.git', 'config')), fs.readFileSync(path.join(outer, '.git', 'index'))].map((b) => b.toString('base64'));
    const before = bytes();
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=push destination parsing|hanging transport return at the bound', fileURLToPath(import.meta.url)], {
      // NODE_TEST_CONTEXT would make the nested runner report to this one and run nothing.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), GIT_DIR: path.join(outer, '.git'), GIT_INDEX_FILE: path.join(outer, '.git', 'index'), GIT_WORK_TREE: outer },
      encoding: 'utf8', timeout: 170000,
    });
    assert.equal(r.status, 0, (r.stdout || '').split('\n').filter((l) => /✖|Error/.test(l)).join('\n'));
    assert.match(r.stdout, /pass 2\b/, 'both standalone tests ran');
    assert.deepEqual(bytes(), before, 'the outer repo config and index are unchanged');
  });

  // origin's push URLs as git stores and routes them: only an exact github.com destination
  // counts. Strings are built with AT so no literal user@host appears in the source.
  test('push destination parsing: ambiguous or non-GitHub URLs are refused; GitHub forms (with :443) are accepted', () => {
    const AT = '@';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land push url '));
    temps.push(tmp);
    const repo = path.join(tmp, 'repo');
    const env = isolatedGitEnv(tmp);
    spawnSync('git', ['init', '--quiet', repo], { env });
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git'], { env });
    const target = (url) => {
      const r = spawnSync('git', ['-C', repo, 'remote', 'set-url', '--push', 'origin', url], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git stored ${JSON.stringify(url)}`);
      return withProcessEnv(env, () => landLib.pushTarget(repo).slug);
    };
    const cred = 'plainword-cred-7f3a';
    for (const url of [
      `https://localhost?${AT}github.com/o/r`, `https://localhost#${AT}github.com/o/r`, `https://${cred}${AT}localhost?${AT}github.com/o/r`,
      'https://github.com.evil.example/o/r', `https://github.com${AT}evil.example/o/r`, 'https://evil.example/github.com/o/r',
      'http://github.com/o/r', 'https://github.com/o/r?x=1', 'https://github.com/o/r#f', 'https://github.com:8443/o/r',
      `git${AT}github.com:/o/r`, `https://u\\${AT}github.com/o/r`, `https://a${AT}b${AT}github.com/o/r`, 'github.com:o/r/extra',
      'https://github.com/o', 'git://github.com/o/r', 'https://%67ithub.com/o/r', 'https://github.com./o/r', 'https://github.com/o/r\tx',
      // Malformed authorities around the userinfo: still refused.
      `https://localhost:${cred}?${AT}github.com/o/r`, 'https://github.com:/o/r', 'https://github.com:443:1/o/r', `https://user:pass${AT}github.com:22/o/r`,
    ]) {
      assert.equal(target(url), null, `refused: ${JSON.stringify(url)}`);
    }
    for (const url of [
      'https://github.com/o/r.git', 'https://github.com:443/o/r', `https://x-access-token:${cred}${AT}github.com/o/r.git`,
      `ssh://git${AT}github.com:22/o/r.git`, `ssh://git${AT}github.com/o/r`, `git${AT}github.com:o/r.git`, 'https://GitHub.com/o/r/',
      // userinfo as git reads it (proven through a local proxy: git connects to github.com:443):
      // a password with a colon, an empty user, an empty userinfo.
      `https://user:pa:ss${AT}github.com/o/r.git`, `https://:${cred}${AT}github.com/o/r.git`, `https://${AT}github.com/o/r.git`,
    ]) {
      assert.equal(target(url), 'o/r', `accepted: ${JSON.stringify(url)}`);
    }
  });

  // The no-kill test hook works only in the test mode: the switch alone (leaked into a real
  // lander's environment) still stops a command at its timeout.
  test('the no-kill switch without the test mode still stops a hung command', { timeout: 120000 }, async () => {
    const saved = { s: process.env.AGENT_LAND_TEST_NO_KILL, n: process.env.AGENT_ENV_NO_SECRETS, k: process.env.AGENT_LAND_STUCK_MS };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land kill '));
    temps.push(tmp);
    const pidFile = path.join(tmp, 'pid');
    process.env.AGENT_LAND_TEST_NO_KILL = '1';
    delete process.env.AGENT_ENV_NO_SECRETS;
    process.env.AGENT_LAND_STUCK_MS = '3000';
    try {
      const r = await runAsync([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`], { timeoutMs: 2000 });
      assert.equal(r.timedOut, true);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 250)); } catch { alive = false; }
      }
      assert.equal(alive, false, 'the command was stopped');
    } finally {
      for (const [k, v] of [['AGENT_LAND_TEST_NO_KILL', saved.s], ['AGENT_ENV_NO_SECRETS', saved.n], ['AGENT_LAND_STUCK_MS', saved.k]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('call bounds stay inside the lock ttl: a sixth for gh and local git, a third for git network calls', () => {
    const saved = { io: process.env.AGENT_LAND_IO_TIMEOUT_MS, net: process.env.AGENT_LAND_NET_TIMEOUT_MS };
    try {
      delete process.env.AGENT_LAND_IO_TIMEOUT_MS;
      delete process.env.AGENT_LAND_NET_TIMEOUT_MS;
      setLockTtl(1);
      assert.equal(ioTimeoutMs(), 10000);
      assert.equal(netTimeoutMs(), 20000);
      process.env.AGENT_LAND_IO_TIMEOUT_MS = '999999';
      process.env.AGENT_LAND_NET_TIMEOUT_MS = '999999';
      assert.equal(ioTimeoutMs(), 10000, 'an override never exceeds the ttl share');
      assert.equal(netTimeoutMs(), 20000);
      delete process.env.AGENT_LAND_IO_TIMEOUT_MS;
      delete process.env.AGENT_LAND_NET_TIMEOUT_MS;
      setLockTtl(45);
      assert.equal(ioTimeoutMs(), 120000);
      assert.equal(netTimeoutMs(), 600000);
    } finally {
      setLockTtl(45);
      for (const [k, v] of [['AGENT_LAND_IO_TIMEOUT_MS', saved.io], ['AGENT_LAND_NET_TIMEOUT_MS', saved.net]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  // A transport that never answers (a remote helper that sleeps, holding git's pipes): fetch and
  // ls-remote return at the network bound with a timeout, not when the transfer ends.
  test('git fetch and ls-remote over a hanging transport return at the bound', { timeout: 120000 }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land hang '));
    temps.push(tmp);
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git-remote-hang'), '#!/bin/sh\nsleep 60\n');
    fs.chmodSync(path.join(bin, 'git-remote-hang'), 0o755);
    const repo = path.join(tmp, 'repo');
    const base = isolatedGitEnv(tmp);
    spawnSync('git', ['init', '--quiet', repo], { env: base });
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'hang::nowhere'], { env: base });
    const pk = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const env = { ...base, [pk]: `${bin}${path.delimiter}${base[pk]}` };
    const saved = process.env.AGENT_LAND_NET_TIMEOUT_MS;
    process.env.AGENT_LAND_NET_TIMEOUT_MS = '3000';
    try {
      for (const args of [['fetch', '--quiet', 'origin'], ['ls-remote', '--heads', 'origin']]) {
        const started = Date.now();
        const r = landGit(args, { cwd: repo, env });
        assert.equal(r.timedOut, true, `${args[0]}: ${r.status} ${r.stderr}`);
        assert.equal(r.status, 124);
        assert.ok(Date.now() - started < 30000, `${args[0]} returned at the bound`);
      }
    } finally {
      if (saved === undefined) delete process.env.AGENT_LAND_NET_TIMEOUT_MS; else process.env.AGENT_LAND_NET_TIMEOUT_MS = saved;
    }
  });

  test('splitArgv keeps Windows paths and quoted words', () => {
    assert.deepEqual(splitArgv('node "C:\\Program Files\\x\\y.mjs" --a b'), ['node', 'C:\\Program Files\\x\\y.mjs', '--a', 'b']);
    assert.deepEqual(splitArgv("npm run 'gate:all'"), ['npm', 'run', 'gate:all']);
    assert.deepEqual(splitArgv('a "say \\"hi\\"" c'), ['a', 'say "hi"', 'c']);
    assert.throws(() => splitArgv('a "b'));
  });

  test('Landing section: write, append, parse; other text kept', () => {
    const body = 'Summary\n\nLinear-Priority: 1\nDepends-on: #4, #7\n\n## Tests\n\nok\n';
    const a = writeLanding(body, { gateSha: 'a'.repeat(40), queuedAt: '2026-11-06T00:00:00Z', base: 'main' });
    assert.match(a, /## Tests\n\nok/);
    assert.equal(writeLanding(a, { gateSha: 'a'.repeat(40), queuedAt: '2026-11-06T00:00:00Z', base: 'main' }), a, 'idempotent');
    const b = appendLanding(appendLanding(a, 'Bounced: 2026-11-06T01:00:00Z conflict'), `Gate: pass @ ${'b'.repeat(40)} (lander rebase)`);
    const l = parseLanding(b);
    assert.equal(l.gatedSha, 'b'.repeat(40));
    assert.equal(l.gates.length, 2);
    assert.equal(l.bounces.length, 1);
    assert.equal(l.priority, 1);
    assert.deepEqual(l.dependsOn, [4, 7]);
    const c = writeLanding(b, { gateSha: 'c'.repeat(40), queuedAt: '2026-11-07T00:00:00Z', base: 'main' });
    assert.equal(parseLanding(c).gates.length, 1, 're-queue resets the gate lines');
    // The gated base is the last gate line's own: an older line's base never vouches for it.
    assert.equal(parseLanding(a).gatedBase, 'main');
    assert.equal(l.gatedBase, null, 'the last gate line names no base: no base is proven');
    assert.equal(parseLanding(c).gatedBase, 'main');
    const d = parseLanding(appendLanding(a, `Gate: pass @ ${'d'.repeat(40)} (lander rebase) base=release/1.2`));
    assert.deepEqual(d.gates.at(-1), { sha: 'd'.repeat(40), note: 'lander rebase', base: 'release/1.2' });
    const pend = appendLanding(a, `Gate: pending @ ${'e'.repeat(40)} (lander rebase, push started) base=release/1.2`);
    assert.match(confirmPending(pend, 'e'.repeat(40)), new RegExp(`- Gate: pass @ ${'e'.repeat(40)} \\(lander rebase\\) base=release/1\\.2`));
    assert.equal(parseLanding(c).bounces.length, 1, 're-queue keeps the bounce history');
    assert.equal(parseLanding('Linear-Priority: 0').priority, 3, 'no priority means the default');
    assert.equal(parseLanding('').priority, 3);
    assert.equal(parseLanding('- Linear-Priority: 4').priority, 4);
  });

  test('orderQueue: landing, queue-next, priority, time, number', () => {
    const pr = (number, labels, prio, at) => ({ number, labels: labels.map((name) => ({ name })), body: `Linear-Priority: ${prio}\n\n## Landing\n\n- Queued: ${at}\n`, createdAt: at });
    const out = orderQueue([
      pr(1, ['queued'], 4, '2026-11-06T01:00:00Z'),
      pr(2, ['queued'], 2, '2026-11-06T03:00:00Z'),
      pr(3, ['queued', 'queue-next'], 4, '2026-11-06T05:00:00Z'),
      pr(4, ['queued'], 2, '2026-11-06T02:00:00Z'),
      pr(5, ['landing'], 4, '2026-11-06T09:00:00Z'),
      pr(6, ['queued'], 2, '2026-11-06T02:00:00Z'),
      pr(7, ['queued'], 0, '2026-11-06T00:30:00Z'),
    ]).map((p) => p.number);
    assert.deepEqual(out, [5, 3, 4, 6, 2, 7, 1], '0 counts as 3 (Medium), after High and before Low');
  });

  test('lock message round trip and staleness', () => {
    const at = new Date(Date.now() - 50 * 60000).toISOString();
    const info = parseLockMessage(lockMessage({ host: 'h', pid: 7, at, ttl: 45 }));
    assert.deepEqual({ host: info.host, pid: info.pid, ttl: info.ttl }, { host: 'h', pid: 7, ttl: 45 });
    assert.equal(isStale(info, 45), true);
    assert.equal(isStale({ ...info, ttl: 60 }, 45), false, 'the holder ttl wins');
    assert.equal(isStale({}, 45), true, 'unparseable time is stale');
  });

  test('scrub masks credential shapes', () => {
    const s = scrub(`DATABASE_URL=postgres://u:p@h/db API_TOKEN: abc123 sk-${'x'.repeat(24)} me@example.com Bearer abcdefghijkl`);
    assert.doesNotMatch(s, /u:p@|abc123|xxxxxxxx|me@example|abcdefghijkl/);
  });

  test('scrub masks quoted credential keys and quoted values (JSON, YAML)', () => {
    const s = scrub(`{"api_key": "plain1value", "client_secret":"two words here", 'TOKEN': 'q3value', "name": "kept"}`);
    assert.doesNotMatch(s, /plain1value|two words|words here|q3value/);
    assert.match(s, /"name": "kept"/, 'other keys are kept');
  });

  test('rangeDiffChanges', () => {
    const out = '1:  aaaaaaa = 1:  bbbbbbb one\n2:  ccccccc ! 2:  ddddddd two\n    @@ inner diff\n-:  ------- > 3:  eeeeeee three\n';
    const r = rangeDiffChanges(out);
    assert.equal(r.total, 3);
    assert.equal(r.changed.length, 2);
  });

  test('ownedTree: only the command (child of this process) and children created after their parent', async () => {
    const { ownedTree } = await import('../../home/dot_agents/bin/lib/land.mjs');
    assert.equal(typeof ownedTree, 'function');
    const self = 9;
    const procs = [
      { pid: 100, ppid: self, start: '200', cmd: 'gate' },
      { pid: 101, ppid: 100, start: '100', cmd: 'older process that reused the parent pid' },
      { pid: 102, ppid: 100, start: '300', cmd: 'real child' },
      { pid: 103, ppid: 102, start: '', cmd: 'unknown start time' },
      { pid: 104, ppid: 102, start: '400', cmd: 'grandchild' },
    ];
    assert.deepEqual(ownedTree(procs, 100, self).map((p) => p.pid).sort(), [100, 102, 104]);
    assert.deepEqual(ownedTree(procs, 100, 7), [], 'a root that is not our child is not ours (reused pid)');
  });

  test('the lock refresh interval stays well inside the ttl, even at lockTtlMin 1', async () => {
    const { tickMs } = await import('../../home/dot_agents/bin/lib/land.mjs');
    const saved = process.env.AGENT_LAND_TICK_MS;
    delete process.env.AGENT_LAND_TICK_MS;
    try {
      assert.ok(tickMs(1) < 30000, `tick ${tickMs(1)} ms for a 1 min ttl`);
      assert.ok(tickMs(45) <= 15 * 60000);
    } finally {
      if (saved !== undefined) process.env.AGENT_LAND_TICK_MS = saved;
    }
  });

  test('splitArgv refuses shell syntax, as the worktree engine does', () => {
    assert.throws(() => splitArgv('npm test | tee log'), /shell syntax/);
    assert.throws(() => splitArgv('a && b'), /shell syntax/);
  });
});

// ------------------------------------------------------------------------- land-pr

describe('land-pr', () => {
  test('idle repo: merges now, pinned to the gated head, and releases the lock', () => {
    const t = setup();
    const head = makePr(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^MERGED [0-9a-f]{40}$/);
    const p = prOf(t, 1);
    assert.equal(p.state, 'MERGED');
    const merge = state(t).calls.find((c) => c.cmd === 'pr merge');
    assert.equal(merge.head, head);
    assert.equal(merge.deleteBranch, true);
    assert.equal(merge.method, 'squash');
    assert.equal(lockExists(t), false);
    assert.equal(sh(t.bare, t.env, 'show', 'main:f1.txt'), 'pr 1');
    // Idempotent: a second call reports the existing merge.
    const again = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(again.status, 0);
    assert.equal(again.out, `MERGED ${p.mergeCommit}`);
  });

  test('a lock that stays busy: nothing is written (no stale body), REFUSED to retry; someone else\'s lock is left alone', () => {
    const t = setup();
    const head = makePr(t, 1);
    setLock(t, 1);
    const lock = lockSha(t);
    t.env.AGENT_LAND_LOCK_WAIT_MS = '50';
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED the landing lock stayed busy/);
    assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit'), false);
    assert.doesNotMatch(prOf(t, 1).body, /## Landing/);
    assert.equal(lockSha(t), lock);
  });

  test('queueing writes the body only under the landing lock, from a fresh read', () => {
    const t = setup();
    queuePr(t, 2);
    const head = makePr(t, 1);
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, 'QUEUED 2');
    const calls = state(t).calls.slice(before);
    const take = calls.findIndex((c) => c.cmd === 'api' && c.method === 'POST' && c.route === 'refs');
    const edit = calls.findIndex((c) => c.cmd === 'pr edit');
    assert.ok(take >= 0 && edit > take, 'the lock is taken before the edit');
    assert.match(prOf(t, 1).body, new RegExp(`## Landing\\n\\n- Gate: pass @ ${head} base=main\\n- Queued: `));
    assert.equal(lockExists(t), false, 'released');
  });

  test('--release-hold edits only under the landing lock (busy: refused, hold kept)', () => {
    const t = setup();
    const head = heldPr(t);
    setLock(t, 1);
    t.env.AGENT_LAND_LOCK_WAIT_MS = '50';
    const body = prOf(t, 1).body;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED the landing lock stayed busy/);
    assert.equal(prOf(t, 1).body, body);
    assert.deepEqual(prOf(t, 1).labels, ['queued', 'queue-hold']);
  });

  test('a mergeCmd or affectedGate that cannot be run is a config error before any change', () => {
    const t = setup({ mergeCmd: 'gh pr merge {pr} | tee x' });
    const head = makePr(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.err, /mergeCmd\[0\] cannot be run/);
    assert.equal(lockExists(t), false);
    const t2 = setup({ affectedGate: ['node scripts/gate.mjs | tee x'] });
    queuePr(t2, 1);
    advanceMain(t2, 'other.txt', 'x\n');
    const before = state(t2).calls.length;
    const q = tool(t2, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(q.status, 1);
    assert.match(JSON.parse(q.out).error, /affectedGate\[0\] cannot be run/);
    assert.equal(state(t2).calls.slice(before).some((c) => c.cmd === 'pr edit'), false, 'no landing label, no pending line');
    assert.deepEqual(prOf(t2, 1).labels, ['queued']);
    assert.equal(lockExists(t2), false);
  });

  test('head behind the base: queues even with a free lock; position counts the queue', () => {
    const t = setup();
    queuePr(t, 1);
    const head = makePr(t, 2);
    advanceMain(t, 'other.txt', 'x\n');
    const r = tool(t, LAND_PR, '2', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.result, 'QUEUED');
    assert.equal(j.position, 2);
    assert.equal(j.current, false);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('gated sha is not the PR head: exit 1, nothing changed', () => {
    const t = setup();
    makePr(t, 1);
    const old = sh(t.work, t.env, 'rev-parse', 'HEAD~1');
    const r = tool(t, LAND_PR, '1', '--sha', old, '--repo', 'o/r');
    assert.equal(r.status, 1);
    assert.match(r.err, /re-run the gate/);
    assert.deepEqual(prOf(t, 1).labels, []);
  });

  for (const [name, prep, re] of [
    ['queue-hold', (t) => makePr(t, 1, { labels: ['queue-hold'] }), /^REFUSED queue-hold/],
    ['landing', (t) => makePr(t, 1, { labels: ['landing'] }), /^REFUSED landing/],
    ['unmerged Depends-on', (t) => { makePr(t, 2); return makePr(t, 1, { body: 'Depends-on: #2' }); }, /^REFUSED Depends-on #2 not merged/],
    ['paused repo', (t) => { const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s); return makePr(t, 1); }, /^REFUSED repo paused/],
  ]) {
    test(`refuses (exit 2, no merge, no label change): ${name}`, () => {
      const t = setup();
      const head = prep(t);
      const labels = [...prOf(t, 1).labels];
      const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
      assert.equal(r.status, 2, r.err);
      assert.match(r.out, re);
      assert.equal(prOf(t, 1).state, 'OPEN');
      assert.deepEqual(prOf(t, 1).labels, labels);
      assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge' || c.cmd === 'pr edit'), false);
      assert.equal(lockExists(t), false);
    });
  }

  test('Depends-on a merged PR is fine', () => {
    const t = setup();
    const h2 = makePr(t, 2);
    assert.equal(tool(t, LAND_PR, '2', '--sha', h2, '--repo', 'o/r').status, 0);
    const h1 = makePr(t, 1, { body: 'Depends-on: #2' });
    const r = tool(t, LAND_PR, '1', '--sha', h1, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^MERGED /);
  });

  test('a PR already queued only gets its gated sha refreshed, never merged now', () => {
    const t = setup();
    queuePr(t, 1);
    fs.writeFileSync(path.join(t.work, 'more.txt'), 'more\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'more');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    const head = sh(t.work, t.env, 'rev-parse', 'HEAD');
    const queuedAt = parseLanding(prOf(t, 1).body).queuedAt;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.result, 'QUEUED');
    assert.equal(j.refreshed, true);
    const l = parseLanding(prOf(t, 1).body);
    assert.equal(l.gatedSha, head);
    assert.equal(l.gates.length, 1);
    assert.equal(l.queuedAt, queuedAt, 'keeps its place in the queue');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
    assert.equal(lockExists(t), false, 'no lock taken');
  });

  for (const full of [false, true]) {
    test(`a fixed queue-blocked PR goes back in line, never merged now (${full ? 'queue full' : 'room'})`, () => {
      const t = setup({ maxQueued: full ? 1 : 5 });
      if (full) queuePr(t, 2);
      queuePr(t, 1, { queuedAt: '2026-11-06T00:00:00Z' });
      let s = state(t);
      const p1 = s.prs.find((p) => p.number === 1);
      p1.labels = ['queue-blocked'];
      p1.body = appendLanding(p1.body, 'Bounced: 2026-11-06T01:00:00Z conflict');
      saveState(t, s);
      sh(t.work, t.env, 'checkout', '--quiet', 'agent/LEE-1-change');
      fs.writeFileSync(path.join(t.work, 'fix.txt'), 'fix\n');
      sh(t.work, t.env, 'add', '-A');
      sh(t.work, t.env, 'commit', '--quiet', '-m', 'fix');
      sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
      const head = sh(t.work, t.env, 'rev-parse', 'HEAD');
      const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
      assert.equal(r.status, full ? 3 : 0, r.err);
      const j = JSON.parse(r.out);
      assert.equal(j.result, full ? 'QUEUE-FULL' : 'QUEUED');
      assert.equal(j.requeue, true);
      assert.deepEqual(prOf(t, 1).labels, [full ? 'queue-waiting' : 'queued']);
      const l = parseLanding(prOf(t, 1).body);
      assert.equal(l.gatedSha, head);
      assert.equal(l.bounces.length, 1, 'bounce history kept');
      s = state(t);
      assert.equal(s.calls.some((c) => c.cmd === 'pr merge'), false);
      assert.equal(lockExists(t), false);
    });
  }

  test('a queue-blocked PR that also has queue-hold is refused', () => {
    const t = setup();
    const head = makePr(t, 1, { labels: ['queue-blocked', 'queue-hold'] });
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.out, /^REFUSED queue-hold/);
    assert.deepEqual(prOf(t, 1).labels, ['queue-blocked', 'queue-hold']);
  });

  test('fairness: no merge-now while another PR is queued, even with a free lock and a current head', () => {
    const t = setup();
    queuePr(t, 1);
    const head = makePr(t, 2);
    const r = tool(t, LAND_PR, '2', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.result, 'QUEUED');
    assert.equal(j.current, true);
    assert.equal(j.position, 2);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
    assert.equal(lockExists(t), false);
  });

  test('fairness: a new PR waits behind older queue-waiting PRs even when there is room', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).labels = ['queue-waiting']; saveState(t, s);
    const head = makePr(t, 2);
    const r = tool(t, LAND_PR, '2', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 3, r.err);
    assert.equal(r.out, 'QUEUE-FULL 2');
    assert.deepEqual(prOf(t, 2).labels, ['queue-waiting']);
  });

  test('a queue-waiting PR that is oldest and has room moves to queued', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).labels = ['queue-waiting']; saveState(t, s);
    const head = sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change');
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, 'QUEUED 1');
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
  });

  const HOLDER = 't3-thread-abc';
  function heldPr(t, extraBody = '') {
    queuePr(t, 1, { body: extraBody });
    const h = tool(t, LAND_PR, 'hold', '1', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(h.status, 0, h.err);
    assert.equal(h.out, `HELD ${HOLDER}`);
    sh(t.work, t.env, 'checkout', '--quiet', 'agent/LEE-1-change');
    fs.writeFileSync(path.join(t.work, 'edit.txt'), 'edit\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'edit');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    return sh(t.work, t.env, 'rev-parse', 'HEAD');
  }

  test('--release-hold: removes the caller\'s own hold and records the new gated sha in one edit', () => {
    const t = setup();
    const head = heldPr(t);
    const queuedAt = parseLanding(prOf(t, 1).body).queuedAt;
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.result, 'QUEUED');
    assert.equal(j.released, true);
    const p = prOf(t, 1);
    assert.deepEqual(p.labels, ['queued']);
    assert.doesNotMatch(p.body, /Hold-By:/);
    assert.equal(parseLanding(p.body).gatedSha, head);
    assert.equal(parseLanding(p.body).queuedAt, queuedAt);
    const edits = state(t).calls.slice(before).filter((c) => c.cmd === 'pr edit');
    assert.deepEqual(edits[0].remove, ['queue-hold']);
    assert.equal(edits[0].body, true, 'label and gated sha in the same edit');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  // Made a draft, or found to be a fork, while land-pr waits for the lock: the locked read
  // refuses before the release edit, so the hold stays.
  for (const [kind, change, status, msg] of [['draft', { draft: true }, 1, /is a draft/], ['fork', { fork: true }, 2, /from a fork/]]) {
    test(`--release-hold: a PR that becomes a ${kind} while taking the lock keeps its hold (no edit)`, () => {
      const t = setup();
      const head = heldPr(t);
      // Repo-variable read #1 is the unlocked refusal check; the change lands right after it.
      const s = state(t); s.mutateAfter = { kind: 'varGet', n: 1, pr: 1, ...change }; saveState(t, s);
      const body = prOf(t, 1).body;
      const labels = [...prOf(t, 1).labels].sort();
      const before = state(t).calls.length;
      const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
      assert.equal(state(t).mutateAfter.seen >= 1, true);
      assert.equal(r.status, status, `${r.out}\n${r.err}`);
      assert.match(`${r.out}\n${r.err}`, msg);
      assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit' || c.cmd === 'pr merge'), false, 'nothing changed');
      assert.equal(prOf(t, 1).body, body, 'the Hold-By line stays');
      assert.deepEqual([...prOf(t, 1).labels].sort(), labels, 'queue-hold stays');
      assert.equal(lockExists(t), false);
    });
  }

  // A reason found after the release (here `landing`, set right after the locked checks) is a
  // partial result: REFUSED, the release stands, and the reason says so.
  test('--release-hold: a refusal found after the release says the hold was already released', () => {
    const t = setup();
    const head = heldPr(t);
    // Repo-variable reads: #1 unlocked checks, #2 the locked checks before the release.
    const s = state(t); s.mutateAfter = { kind: 'varGet', n: 2, pr: 1, addLabel: 'landing' }; saveState(t, s);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED landing .*; your hold was already released and the gated sha recorded$/);
    const p = prOf(t, 1);
    assert.doesNotMatch(p.body, /Hold-By:/);
    assert.equal(p.labels.includes('queue-hold'), false);
    assert.equal(parseLanding(p.body).gatedSha, head);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
    assert.equal(lockExists(t), false);
  });

  test('hold: adds queue-hold and a Hold-By line in one edit; holder defaults to $T3CODE_THREAD_ID', () => {
    const t = setup();
    queuePr(t, 1);
    t.env.T3CODE_THREAD_ID = 'thread-from-env';
    const r = tool(t, LAND_PR, 'hold', '1', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out).holder, 'thread-from-env');
    const p = prOf(t, 1);
    assert.deepEqual(p.labels.sort(), ['queue-hold', 'queued']);
    assert.match(p.body, /^- Hold-By: thread-from-env \d{4}-\d\d-\d\dT\S+Z events>\d+$/m);
    const edits = state(t).calls.filter((c) => c.cmd === 'pr edit');
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].add, ['queue-hold']);
    assert.equal(edits[0].body, true);
    // A second holder joins (its line shares the first one's events>N); the same holder again
    // is refused.
    const again = tool(t, LAND_PR, 'hold', '1', '--holder', 'x', '--repo', 'o/r');
    assert.equal(again.status, 0, again.err);
    assert.equal(again.out, 'HELD x (joined)');
    const n = prOf(t, 1).body.match(/Hold-By: thread-from-env \S+ events>(\d+)/)[1];
    assert.match(prOf(t, 1).body, new RegExp(`^- Hold-By: x \\S+ events>${n}$`, 'm'));
    assert.equal(state(t).calls.filter((c) => c.cmd === 'pr edit').at(-1).add.length, 0, 'a join adds no label');
    const twice = tool(t, LAND_PR, 'hold', '1', '--holder', 'x', '--repo', 'o/r');
    assert.equal(twice.status, 2);
    assert.match(twice.out, /^REFUSED x already holds it/);
  });

  test('--release-hold leaves a queue-hold that was removed and set again after the caller\'s hold', () => {
    const t = setup();
    const head = heldPr(t);
    const later = new Date(Date.now() + 5000).toISOString();
    const s = state(t);
    s.events.push({ pr: 1, event: 'unlabeled', label: { name: 'queue-hold' }, created_at: later });
    s.events.push({ pr: 1, event: 'labeled', label: { name: 'queue-hold' }, created_at: later });
    saveState(t, s);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED queue-hold was removed and set again after your hold/);
    assert.ok(prOf(t, 1).labels.includes('queue-hold'), 'the owner\'s label stays');
    assert.doesNotMatch(prOf(t, 1).body, new RegExp(`Hold-By: ${HOLDER}`));
  });

  // Holder A holds and releases; holder B holds right after (well within any clock window) and
  // releases: A's removal came before B's label in GitHub's event order, so B's release removes
  // B's label and the PR goes on; nothing is left for the owner to clear.
  test('--release-hold: a hold right after another holder\'s release is released normally', () => {
    const t = setup();
    const head = heldPr(t);
    const a = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(a.status, 0, a.err || a.out);
    assert.equal(prOf(t, 1).labels.includes('queue-hold'), false);
    const b = tool(t, LAND_PR, 'hold', '1', '--holder', 'holder-b', '--repo', 'o/r');
    assert.equal(b.status, 0, b.err);
    assert.match(prOf(t, 1).body, /^- Hold-By: holder-b \S+ events>\d+$/m);
    const rb = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', 'holder-b', '--repo', 'o/r');
    assert.equal(rb.status, 0, rb.err || rb.out);
    assert.doesNotMatch(rb.out, /REFUSED/);
    assert.equal(prOf(t, 1).labels.includes('queue-hold'), false, 'no orphan label');
    assert.doesNotMatch(prOf(t, 1).body, /Hold-By:/);
  });

  test('--release-hold of a hold line with no event baseline leaves the label (unknown is not mine)', () => {
    const t = setup();
    const head = queuePr(t, 1, { body: 'Hold-By: old-holder 2026-11-06T09:00:00Z\n', labels: ['queue-hold'] });
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', 'old-holder', '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /your hold has no proven label origin, so queue-hold is left for the owner to remove by hand/);
    assert.ok(prOf(t, 1).labels.includes('queue-hold'));
  });

  // ---- holds through the command only (owner `--holder owner`), joining with shared provenance

  // A PR queued, held by `first`, then changed (a new head to release with).
  function heldBy(t, first) {
    queuePr(t, 1);
    const h = tool(t, LAND_PR, 'hold', '1', '--holder', first, '--repo', 'o/r');
    assert.equal(h.status, 0, h.err);
    sh(t.work, t.env, 'checkout', '--quiet', 'agent/LEE-1-change');
    fs.writeFileSync(path.join(t.work, 'edit.txt'), 'edit\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'edit');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    return sh(t.work, t.env, 'rev-parse', 'HEAD');
  }
  const joinHold = (t, holder) => tool(t, LAND_PR, 'hold', '1', '--holder', holder, '--repo', 'o/r');
  const releaseBy = (t, holder, head) => tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', holder, '--repo', 'o/r');
  const holders = (t) => parseHolds(prOf(t, 1).body).map((h) => h.holder).sort();

  for (const [name, order] of [['agent first, owner last', [HOLDER, 'owner']], ['owner first, agent last', ['owner', HOLDER]]]) {
    test(`owner joins an agent's hold (shared events>N): ${name}; only the last release removes the label`, () => {
      const t = setup();
      const head = heldBy(t, HOLDER);
      const j = joinHold(t, 'owner');
      assert.equal(j.status, 0, j.err);
      assert.equal(j.out, 'HELD owner (joined)');
      const lines = parseHolds(prOf(t, 1).body);
      assert.equal(lines.find((h) => h.holder === 'owner').after, lines.find((h) => h.holder === HOLDER).after, 'shared N');
      const first = releaseBy(t, order[0], head);
      assert.equal(first.status, 2, first.err);
      assert.match(first.out, /^REFUSED queue-hold is still set by 1 other holder/);
      assert.ok(prOf(t, 1).labels.includes('queue-hold'));
      assert.deepEqual(holders(t), [order[1]], 'only the releaser\'s line went');
      const last = releaseBy(t, order[1], head);
      assert.equal(last.status, 0, last.err || last.out);
      assert.doesNotMatch(last.out, /REFUSED/);
      assert.equal(prOf(t, 1).labels.includes('queue-hold'), false);
      assert.deepEqual(holders(t), []);
    });
  }

  test('owner joins a hand-set queue-hold: no proven origin, so the last release keeps the label for the owner', () => {
    const t = setup();
    const head = queuePr(t, 1, { labels: ['queue-hold'] });
    const j = joinHold(t, 'owner');
    assert.equal(j.status, 0, j.err);
    assert.match(j.out, /^HELD owner \(joined\): the label's origin is not proven/);
    assert.equal(parseHolds(prOf(t, 1).body)[0].after, null);
    const r = releaseBy(t, 'owner', head);
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /your hold has no proven label origin, so queue-hold is left for the owner to remove by hand/);
    assert.ok(prOf(t, 1).labels.includes('queue-hold'));
    assert.deepEqual(holders(t), []);
  });

  test('owner joins after the label was removed and set again: not proven; no release removes it', () => {
    const t = setup();
    const head = heldBy(t, HOLDER);
    const s = state(t);
    s.events.push({ pr: 1, event: 'unlabeled', label: { name: 'queue-hold' }, created_at: new Date().toISOString() });
    s.events.push({ pr: 1, event: 'labeled', label: { name: 'queue-hold' }, created_at: new Date().toISOString() });
    saveState(t, s);
    const j = joinHold(t, 'owner');
    assert.equal(j.status, 0, j.err);
    assert.match(j.out, /origin is not proven/);
    const a = releaseBy(t, HOLDER, head);
    assert.equal(a.status, 2);
    assert.match(a.out, /still set by 1 other holder/);
    const o = releaseBy(t, 'owner', head);
    assert.equal(o.status, 2);
    assert.match(o.out, /no proven label origin/);
    assert.ok(prOf(t, 1).labels.includes('queue-hold'));
  });

  test('owner hold, agents A and B join: every release order removes only its own line; the last removes the label', { timeout: 600000 }, () => {
    const perms = [['owner', 'a', 'b'], ['owner', 'b', 'a'], ['a', 'owner', 'b'], ['a', 'b', 'owner'], ['b', 'owner', 'a'], ['b', 'a', 'owner']];
    for (const order of perms) {
      const t = setup();
      const head = heldBy(t, 'owner');
      for (const h of ['a', 'b']) assert.equal(joinHold(t, h).out, `HELD ${h} (joined)`);
      const left = ['a', 'b', 'owner'];
      order.forEach((who, i) => {
        const r = releaseBy(t, who, head);
        left.splice(left.indexOf(who), 1);
        if (i < 2) {
          assert.equal(r.status, 2, `${order}: ${who}`);
          assert.match(r.out, new RegExp(`still set by ${left.length} other holder`));
          assert.ok(prOf(t, 1).labels.includes('queue-hold'), `${order}: label kept after ${who}`);
        } else {
          assert.equal(r.status, 0, `${order}: last ${who}: ${r.out} ${r.err}`);
          assert.equal(prOf(t, 1).labels.includes('queue-hold'), false, `${order}: label removed by the last`);
        }
        assert.deepEqual(holders(t), [...left].sort(), `${order}: the other lines survive ${who}`);
      });
    }
  });

  test('a join while the landing lock is busy is refused with nothing written', () => {
    const t = setup();
    heldBy(t, HOLDER);
    const before = prOf(t, 1).body;
    setLock(t, 0);
    const j = joinHold(t, 'owner');
    assert.equal(j.status, 2);
    assert.match(j.out, /^REFUSED the landing lock is busy/);
    assert.equal(prOf(t, 1).body, before);
    sh(t.bare, t.env, 'update-ref', '-d', 'refs/heads/agent-landing-lock');
    assert.equal(joinHold(t, 'owner').status, 0);
  });

  test('--release-hold leaves queue-hold when its history cannot be read', () => {
    const t = setup();
    const head = heldPr(t);
    const s = state(t); s.eventsFail = true; saveState(t, s);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /history could not be read/);
    assert.ok(prOf(t, 1).labels.includes('queue-hold'));
  });

  test('hold and --release-hold need a stable holder: no --holder and no $T3CODE_THREAD_ID refuses', () => {
    const t = setup();
    const head = queuePr(t, 1);
    const r = tool(t, LAND_PR, 'hold', '1', '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.err, /pass --holder <id>/);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    const rel = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--repo', 'o/r');
    assert.equal(rel.status, 2);
    assert.match(rel.err, /pass --holder <id>/);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr edit'), false);
  });

  test('--release-hold runs the read-only checks before any edit (unmet Depends-on, landing)', () => {
    const t = setup();
    const head = heldPr(t);
    let s = state(t); s.prs.find((p) => p.number === 1).body += '\nDepends-on: #99\n'; saveState(t, s);
    const body = prOf(t, 1).body;
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED Depends-on #99 not merged/);
    assert.equal(prOf(t, 1).body, body, 'the hold line stays');
    assert.deepEqual(prOf(t, 1).labels.sort(), ['queue-hold', 'queued']);
    assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit'), false);
    s = state(t); s.prs.find((p) => p.number === 1).labels = ['landing', 'queue-hold']; s.prs.find((p) => p.number === 1).body = body.replace('Depends-on: #99', ''); saveState(t, s);
    const l = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(l.status, 2);
    assert.match(l.out, /^REFUSED landing/);
    assert.deepEqual(prOf(t, 1).labels, ['landing', 'queue-hold']);
  });

  test('--release-hold with other holders: a pause or an unmerged Depends-on refuses before any edit', () => {
    for (const blocker of ['pause', 'dep']) {
      const t = setup();
      const head = heldPr(t);
      const s = state(t);
      const p0 = s.prs.find((p) => p.number === 1);
      p0.body += '\nHold-By: owner 2026-11-06T09:00:00Z\n';
      if (blocker === 'pause') s.variables = { AGENT_LANDING_PAUSED: '1' }; else p0.body += 'Depends-on: #99\n';
      saveState(t, s);
      const body = prOf(t, 1).body;
      const before = state(t).calls.length;
      const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
      assert.equal(r.status, 2, r.err);
      assert.match(r.out, blocker === 'pause' ? /^REFUSED repo paused/ : /^REFUSED Depends-on #99 not merged/);
      assert.equal(prOf(t, 1).body, body, `${blocker}: both hold lines stay`);
      assert.deepEqual(prOf(t, 1).labels, ['queued', 'queue-hold']);
      assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit'), false);
    }
  });

  for (const [what, mutate, expect] of [
    ['a retarget', { base: 'other' }, (r) => { assert.equal(r.status, 1); assert.match(r.err, /now targets other/); }],
    ['a new Depends-on', { appendBody: '\nDepends-on: #99\n' }, (r) => { assert.equal(r.status, 2); assert.match(r.out, /^REFUSED Depends-on #99 not merged/); }],
  ]) {
    test(`merge-now: ${what} seen only by the last read before the merge stops it`, () => {
      const t = setup();
      const head = makePr(t, 1);
      // Repo-variable reads: #1 before the lock, #2 in the first read under the lock; the change
      // lands right after #2, so only the last read before the merge sees it.
      const s = state(t); s.mutateAfter = { kind: 'varGet', n: 2, pr: 1, ...mutate }; saveState(t, s);
      const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
      expect(r);
      assert.equal(state(t).mutateAfter.seen >= 2, true, 'the change happened under the lock');
      assert.equal(prOf(t, 1).state, 'OPEN');
      assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
      assert.equal(lockExists(t), false);
    });
  }

  test('merge-now: a PR queued during the final checks goes first (fairness re-checked after the last read)', () => {
    const t = setup();
    makePr(t, 2);
    const head = makePr(t, 1);
    // Repo-variable reads: #1 before the lock, #2 first read under the lock, #3 the last read;
    // PR 2 is queued right after #3, after the earlier fairness check.
    const s = state(t); s.mutateAfter = { kind: 'varGet', n: 3, pr: 2, addLabel: 'queued' }; saveState(t, s);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.equal(state(t).mutateAfter.seen >= 3, true);
    assert.equal(JSON.parse(r.out).result, 'QUEUED');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
    assert.equal(lockExists(t), false);
  });

  // A retarget right after the first (unlocked) checks, seen first by the locked read: refused
  // in every mode, before any edit or merge (B4: the validated target is never re-based).
  for (const mode of ['merge-now', 'queue', 'release-hold', 'hold']) {
    test(`a retarget while taking the lock is refused before any change (${mode})`, () => {
      const t = setup();
      sh(t.bare, t.env, 'branch', 'other', 'main');
      let args;
      if (mode === 'release-hold') {
        const head = heldPr(t);
        args = ['1', '--sha', head, '--release-hold', '--holder', HOLDER];
      } else if (mode === 'hold') {
        queuePr(t, 1);
        args = ['hold', '1', '--holder', HOLDER];
      } else {
        if (mode === 'queue') queuePr(t, 2);
        args = ['1', '--sha', makePr(t, 1)];
      }
      // The change lands right after the unlocked checks: after repo-variable read #1 (the
      // refusal checks), or for hold (no variable read) after its first read of the PR.
      const s = state(t);
      s.mutateAfter = mode === 'hold' ? { kind: 'prView', n: 1, pr: 1, base: 'other' } : { kind: 'varGet', n: 1, pr: 1, base: 'other' };
      saveState(t, s);
      const body = prOf(t, 1).body;
      const labels = [...prOf(t, 1).labels].sort();
      const before = state(t).calls.length;
      const r = tool(t, LAND_PR, ...args, '--repo', 'o/r');
      assert.notEqual(r.status, 0, r.out);
      assert.match(`${r.out}\n${r.err}`, /now targets other/);
      const calls = state(t).calls.slice(before);
      assert.equal(calls.some((c) => c.cmd === 'pr edit' || c.cmd === 'pr merge'), false, 'nothing changed');
      assert.equal(prOf(t, 1).body, body);
      assert.deepEqual([...prOf(t, 1).labels].sort(), labels);
      assert.equal(lockExists(t), false);
    });
  }

  test('capacity: a queue-hold PR does not use a slot (it still counts for fairness)', () => {
    const t = setup({ maxQueued: 2 });
    queuePr(t, 1, { labels: ['queue-hold'] });
    queuePr(t, 2);
    const head = makePr(t, 3);
    const r = tool(t, LAND_PR, '3', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out).result, 'QUEUED', 'queued, not merged now (fairness) and not QUEUE-FULL');
    assert.deepEqual(prOf(t, 3).labels, ['queued']);
  });

  test('a repo with no gate is a config error: nothing merges', () => {
    const t = setup({ gate: [], affectedGate: [] });
    const head = makePr(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.err, /no gate or affectedGate/);
    assert.equal(prOf(t, 1).state, 'OPEN');
    queuePr(t, 2);
    const q = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(q.status, 1);
    assert.match(JSON.parse(q.out).error, /no gate or affectedGate/);
    assert.deepEqual(prOf(t, 2).labels, ['queued']);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('merge-now runs a due wide sweep under the lock; red pauses the repo', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    const head = makePr(t, 1);
    t.env.LAND_TEST_SWEEP = 'fail';
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.result, 'MERGED');
    assert.equal(j.sweep.ran, true);
    assert.equal(j.sweep.ok, false);
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
    assert.equal(lockExists(t), false);
  });

  test('merge-now clears queue labels after the merge', () => {
    const t = setup();
    const head = makePr(t, 1, { labels: ['queue-next'] });
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(prOf(t, 1).labels, []);
  });

  test('hold edits only under the landing lock: a busy lock refuses with no edit; a hold releases the lock', () => {
    const t = setup();
    queuePr(t, 1);
    setLock(t, 1);
    const lock = lockSha(t);
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, 'hold', '1', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED the landing lock is busy/);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.doesNotMatch(prOf(t, 1).body, /Hold-By:/);
    assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit'), false);
    assert.equal(lockSha(t), lock, 'the other lock is untouched');
    sh(t.bare, t.env, 'update-ref', '-d', 'refs/heads/agent-landing-lock');
    const ok = tool(t, LAND_PR, 'hold', '1', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(ok.status, 0, ok.err);
    assert.equal(lockExists(t), false, 'released after the hold');
  });

  test('an inherited GIT_INDEX_FILE (outer repo) is never touched by the fixture', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'outer repo '));
    temps.push(outer);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    sh(outer, clean, 'init', '--quiet', outer);
    fs.writeFileSync(path.join(outer, 'staged.txt'), 'staged\n');
    sh(outer, clean, 'add', 'staged.txt');
    const index = path.join(outer, '.git', 'index');
    const before = fs.readFileSync(index);
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = index;
    try {
      setup();
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
    }
    assert.ok(fs.readFileSync(index).equals(before), 'the outer index is byte-identical');
  });

  test('hold refuses a landing PR', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).labels = ['landing']; saveState(t, s);
    const r = tool(t, LAND_PR, 'hold', '1', '--holder', 'x', '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.out, /^REFUSED landing/);
    assert.deepEqual(prOf(t, 1).labels, ['landing']);
  });

  test('--release-hold refuses a hold the caller did not set', () => {
    const t = setup();
    const head = heldPr(t);
    const body = prOf(t, 1).body;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', 'someone-else', '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.out, /^REFUSED queue-hold was not set by someone-else/);
    assert.deepEqual(prOf(t, 1).labels, ['queued', 'queue-hold']);
    assert.equal(prOf(t, 1).body, body);
  });

  test('--release-hold keeps queue-hold while another holder remains', () => {
    const t = setup();
    const head = heldPr(t);
    const s = state(t); const p0 = s.prs.find((p) => p.number === 1); p0.body += '\nHold-By: owner 2026-11-06T09:00:00Z\n'; saveState(t, s);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--release-hold', '--holder', HOLDER, '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.out, /^REFUSED queue-hold is still set by 1 other holder/);
    const p = prOf(t, 1);
    assert.deepEqual(p.labels, ['queued', 'queue-hold']);
    assert.doesNotMatch(p.body, new RegExp(HOLDER));
    assert.match(p.body, /Hold-By: owner/);
  });

  test('capacity: queued + landing at maxQueued -> queue-waiting, QUEUE-FULL, exit 3', () => {
    const t = setup({ maxQueued: 2 });
    queuePr(t, 1);
    queuePr(t, 2, { labels: ['landing'] });
    queuePr(t, 3);
    const s = state(t); s.prs.find((p) => p.number === 3).labels = ['queue-blocked']; saveState(t, s);
    const head = makePr(t, 4);
    advanceMain(t, 'other.txt', 'x\n');
    const r = tool(t, LAND_PR, '4', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 3, r.err);
    assert.equal(r.out, 'QUEUE-FULL 3');
    assert.deepEqual(prOf(t, 4).labels, ['queue-waiting']);
    assert.equal(parseLanding(prOf(t, 4).body).gatedSha, head);
  });

  test('dry run makes no changes', () => {
    const t = setup();
    const head = makePr(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--dry-run');
    assert.equal(r.out, 'WOULD-MERGE');
    assert.deepEqual(state(t).calls.filter((c) => c.cmd !== 'api' || c.method !== 'GET'), [], 'reads only');
  });
});

// ------------------------------------------------------------------------- land-queue

describe('land-queue', () => {
  test('status orders the queue; held and waiting PRs are listed apart', () => {
    const t = setup();
    queuePr(t, 1, { priority: 4, queuedAt: '2026-11-06T01:00:00Z' });
    queuePr(t, 2, { priority: 2, queuedAt: '2026-11-06T03:00:00Z' });
    queuePr(t, 3, { priority: 4, labels: ['queue-next'], queuedAt: '2026-11-06T05:00:00Z' });
    queuePr(t, 4, { labels: ['queue-hold'] });
    queuePr(t, 5, { body: 'Depends-on: #4' });
    const r = tool(t, LAND_QUEUE, 'status', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const s = JSON.parse(r.out);
    assert.deepEqual(s.order.map((x) => x.pr), [3, 2, 1]);
    assert.deepEqual(s.held, [4]);
    assert.deepEqual(s.waiting, [{ pr: 5, dependsOn: [4] }]);
    assert.equal(s.lock, null);
  });

  test('status --all reads the engine registry; an unresolvable repo is an error, not a stop', () => {
    const t = setup();
    queuePr(t, 1);
    // A second checkout whose origin names the GitHub repo (status needs no git remote access).
    const gh = path.join(t.tmp, 'gh checkout');
    sh(t.tmp, t.env, 'clone', '--quiet', t.bare, gh);
    sh(gh, t.env, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    const reg = path.join(t.home, '.agents', 'state', 'repos.json');
    fs.mkdirSync(path.dirname(reg), { recursive: true });
    fs.writeFileSync(reg, JSON.stringify({ version: 1, repos: [
      { root: gh, name: 'r', lastSeen: '2026-11-06T00:00:00Z' },
      { root: t.work, name: 'r', lastSeen: '2026-11-06T00:00:00Z' },
      { root: path.join(t.tmp, 'gone'), name: 'gone', lastSeen: '2026-11-06T00:00:00Z' },
    ] }));
    // The fixture checkout (a local origin) is not declared as a GitHub repo here: unresolvable.
    delete t.env.AGENT_LAND_TEST_FAKE_GITHUB;
    const r = tool(t, LAND_QUEUE, 'status', '--all', '--json');
    assert.equal(r.status, 1, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.length, 2);
    assert.equal(out[0].repo, 'o/r');
    assert.deepEqual(out[0].order.map((x) => x.pr), [1]);
    assert.match(out[1].error, /cannot prove where the landing lock would be released/);
  });

  test('run: rebases a PR behind the base, reruns the gate, pushes, merges', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.equal(rep.merged.length, 1);
    assert.equal(rep.merged[0].pr, 1);
    assert.equal(rep.merged[0].rebased, true);
    assert.equal(rep.queued, 0);
    const p = prOf(t, 1);
    assert.equal(p.state, 'MERGED');
    assert.match(p.body, /\(lander rebase\)/);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 1, 'gate ran once');
    assert.equal(sh(t.bare, t.env, 'show', 'main:other.txt'), 'x');
    assert.equal(sh(t.bare, t.env, 'show', 'main:f1.txt'), 'pr 1');
    assert.equal(lockExists(t), false);
    const wt = sh(t.work, t.env, 'worktree', 'list', '--porcelain');
    assert.match(wt, /my repo-lander[\s\S]*\nlocked/);
  });

  test('run: lands several PRs in order; a current PR is merged without a gate rerun', () => {
    const t = setup();
    queuePr(t, 1, { priority: 4 });
    queuePr(t, 2, { priority: 1 });
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [2, 1]);
    assert.equal(rep.merged[0].rebased, false);
    assert.equal(rep.merged[1].rebased, true, 'the second PR is behind after the first merge');
  });

  test('run: bounces a PR whose head changed after the gate', () => {
    const t = setup();
    queuePr(t, 1);
    fs.writeFileSync(path.join(t.work, 'late.txt'), 'late\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'late');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.equal(rep.bounced.length, 1);
    assert.match(rep.bounced[0].reason, /head changed after the gate/);
    assert.equal(rep.bounced[0].attempt, 1);
    const p = prOf(t, 1);
    assert.deepEqual(p.labels, ['queue-blocked']);
    assert.match(p.body, /- Bounced: \S+ head changed/);
    const c = state(t).comments.filter((x) => x.pr === 1);
    assert.equal(c.length, 1);
    assert.match(c[0].body, /land-queue:bounce/);
    assert.equal(lockExists(t), false);
  });

  test('run: bounces on a rebase conflict and leaves the PR branch alone', () => {
    const t = setup();
    const head = queuePr(t, 1, { file: 'README.md', content: 'line one\nPR EDIT\nline three\n' });
    advanceMain(t, 'README.md', 'line one\nMAIN EDIT\nline three\n');
    const rep = runQueue(t);
    assert.equal(rep.bounced.length, 1);
    assert.match(rep.bounced[0].reason, /conflicts in 1 file\(s\): README\.md/);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head);
  });

  test('run: a red affected gate is retried once, then bounced; no gate output reaches the PR or the report', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    fs.writeFileSync(t.env.LAND_TEST_GATE, 'fail');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const rep = JSON.parse(r.out);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /affected gate failed: affectedGate\[0\] `node scripts\/gate\.mjs` exit 1/);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 2);
    assert.equal(prOf(t, 1).state, 'OPEN');
    const comments = state(t).comments.map((c) => c.body).join('\n');
    assert.doesNotMatch(comments, /SHOULD-NOT-LEAK/);
    assert.doesNotMatch(`${r.out}\n${r.err}`, /SHOULD-NOT-LEAK/);
  });

  test('run: a gate that hangs is stopped at the command timeout, with its child processes', { timeout: 180000 }, () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    Object.assign(t.env, { LAND_TEST_GATE_HANG: '1', AGENT_LAND_CMD_TIMEOUT_MS: '3000' });
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /timed out after/);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 1, 'a timed-out gate is not retried');
    const child = Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}.child`, 'utf8'));
    let alive = true;
    try { process.kill(child, 0); } catch { alive = false; }
    assert.equal(alive, false, 'the gate\'s child process was stopped too');
    // A timeout cannot prove nothing else the gate started survives: the lock is kept.
    assert.ok(rep.lockRetained?.sha);
    assert.equal(lockExists(t), true);
  });

  // ---- landing steps that run repo code (hooks, merge wrappers) are bounded and refresh the lock

  // A pre-push hook in the shared hooks folder that runs only while <tmp>/push-hook-flag exists.
  const pushHook = (t, body) => {
    const flag = path.join(t.tmp, 'push-hook-flag');
    t.env.PUSH_HOOK_FLAG = flag;
    const hook = path.join(t.work, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -f "$PUSH_HOOK_FLAG" ]; then\n${body}\nfi\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(flag, '');
  };

  test('run: a pre-push hook that hangs is stopped at the command timeout: lock kept, nothing reset or relabelled', { timeout: 180000 }, () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    pushHook(t, 'sleep 40');
    Object.assign(t.env, { AGENT_LAND_CMD_TIMEOUT_MS: '4000', AGENT_LAND_STUCK_MS: '3000' });
    const started = Date.now();
    const rep = runQueue(t);
    assert.ok(Date.now() - started < 30000, 'the hung hook did not hold the lander');
    assert.match(rep.aborted[0].reason, /push of the rebased head timed out .* landing lock is kept/);
    assert.ok(rep.lockRetained?.sha, 'the lock is kept');
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    assert.deepEqual(prOf(t, 1).labels, ['landing'], 'no relabel');
    assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('run: a merge wrapper that hangs is stopped at the command timeout: no bounce, lock kept', { timeout: 180000 }, () => {
    const t = setup({ mergeCmd: 'node scripts/hang-merge.mjs {pr}' });
    fs.writeFileSync(path.join(t.work, 'scripts', 'hang-merge.mjs'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40000);\n');
    queuePr(t, 1);
    Object.assign(t.env, { AGENT_LAND_CMD_TIMEOUT_MS: '4000', AGENT_LAND_STUCK_MS: '3000' });
    const started = Date.now();
    const rep = runQueue(t);
    assert.ok(Date.now() - started < 60000);
    assert.equal(rep.merged.length, 0);
    assert.equal(rep.bounced.length, 0, 'no bounce: the merge may still happen');
    assert.match(rep.aborted[0].reason, /merge command timed out .* landing lock is kept/);
    assert.ok(rep.lockRetained?.sha);
    assert.equal(prOf(t, 1).state, 'OPEN');
    assert.deepEqual(prOf(t, 1).labels, ['landing']);
  });

  test('run: a lock refresh that hangs is bounded inside a 1-minute ttl: lost, the gate stops, nothing relabelled', { timeout: 180000 }, () => {
    const t = setup({ lockTtlMin: 1 });
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    // The gate would run 40 s; the first refresh (every 2 s) hangs for a minute; gh calls are
    // bounded at a sixth of the ttl (10 s).
    Object.assign(t.env, { LAND_TEST_GATE_SLEEP_MS: '40000', AGENT_LAND_TICK_MS: '2000', FAKE_GH_HANG_LOCK_PATCH: '1' });
    const started = Date.now();
    const rep = runQueue(t);
    assert.ok(Date.now() - started < 55000, `stopped at the gh bound, well before the 60 s hang ended (${Date.now() - started} ms)`);
    assert.match(rep.aborted[0].reason, /landing lock was lost/);
    assert.deepEqual(prOf(t, 1).labels, ['landing'], 'no relabel after the loss');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('run: the lock taken while a pre-push hook hangs: stopped as lost; no reset, relabel or release of the new lock', { timeout: 180000 }, () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const stolen = path.join(t.tmp, 'stolen');
    t.env.STOLEN_FILE = stolen;
    pushHook(t, [
      // A hook runs with GIT_DIR set to the lander's repo: name the bare origin explicitly.
      'lock=refs/heads/agent-landing-lock',
      'c=$(git --git-dir="$FAKE_GH_BARE" commit-tree "$(git --git-dir="$FAKE_GH_BARE" rev-parse "$lock^{tree}")" -m "agent-landing-lock host=other pid=1 at=2099-01-01T00:00:00Z ttl=45")',
      'git --git-dir="$FAKE_GH_BARE" update-ref "$lock" "$c"',
      'printf %s "$c" > "$STOLEN_FILE"',
      'sleep 90',
    ].join('\n'));
    Object.assign(t.env, { AGENT_LAND_TICK_MS: '500', AGENT_LAND_STUCK_MS: '3000' });
    const started = Date.now();
    const rep = runQueue(t);
    assert.ok(Date.now() - started < 60000);
    assert.match(rep.aborted[0].reason, /landing lock was lost during the push/);
    assert.equal(lockSha(t), fs.readFileSync(stolen, 'utf8'), 'the other lander keeps its lock');
    assert.deepEqual(prOf(t, 1).labels, ['landing']);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head);
    assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset');
  });

  // The lock is released by pushing to origin: origin's actual push destination (after
  // insteadOf / pushInsteadOf) must be the repo the lock is created in.
  test('push destination: an undeclared local path, a wrong repo among several, or the switch outside test mode is refused', () => {
    const cases = [
      ['undeclared local path', (t) => { t.env.AGENT_LAND_TEST_FAKE_GITHUB = `o/r=${path.join(t.tmp, 'elsewhere.git')}`; }],
      ['test switch outside the test mode', (t) => { delete t.env.AGENT_ENV_NO_SECRETS; }],
      ['a second push URL to another repo', (t) => { sh(t.work, t.env, 'remote', 'set-url', '--add', '--push', 'origin', t.bare); sh(t.work, t.env, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/someone/else.git'); }],
      // git config keys take forward slashes: a Windows path's backslashes would not match.
      // pushInsteadOf applies to the push URL derived from `url` (not to an explicit pushurl).
      ['pushInsteadOf rewrites the push to an undeclared place', (t) => {
        sh(t.work, t.env, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
        sh(t.work, t.env, 'config', `url.${path.join(t.tmp, 'elsewhere.git').replace(/\\/g, '/')}.pushInsteadOf`, 'https://github.com/o/r.git');
      }],
      ['pushInsteadOf rewrites a github.com/o/r push to another GitHub repo', (t) => {
        sh(t.work, t.env, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
        sh(t.work, t.env, 'config', 'url.https://github.com/zzz/.pushInsteadOf', 'https://github.com/o/');
      }],
    ];
    for (const [name, arrange] of cases) {
      const t = setup();
      const head = queuePr(t, 1);
      arrange(t);
      const before = state(t).calls.length;
      const p = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
      assert.equal(p.status, 2, `${name}: ${p.out} ${p.err}`);
      assert.match(p.err, /cannot prove where the landing lock would be released|is not the repo origin pushes to/, name);
      assert.doesNotMatch(p.err, /https?:\/\/|elsewhere/, `${name}: no URL or path is quoted`);
      const q = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
      assert.notEqual(q.status, 0, name);
      assert.equal(lockExists(t), false, `${name}: no lock`);
      assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit' || c.cmd === 'pr merge' || (c.cmd === 'api' && c.method !== 'GET')), false, `${name}: no writes`);
    }
  });

  test('push destination: a credential in a refused URL never reaches the output; nothing is read or written', () => {
    const AT = '@';
    const t = setup();
    const head = queuePr(t, 1);
    // The old substring match read this as o/r (userinfo `localhost:<cred>?`); git's authority is
    // `localhost:<cred>` (an invalid port, so nothing connects anywhere).
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', `https://localhost:plainword-cred-7f3a?${AT}github.com/o/r`);
    const before = state(t).calls.length;
    const p = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(p.status, 2);
    assert.match(p.err, /cannot prove where the landing lock would be released: 1 of origin's 1 push URL\(s\) name no github\.com repo/);
    assert.doesNotMatch(p.out + p.err, /plainword-cred|localhost/);
    assert.equal(state(t).calls.length, before, 'no gh call at all');
    assert.equal(lockExists(t), false);
  });

  test('push destination: a fetch mirror is fine when every push goes to the repo; an override push URL to it lands', () => {
    // Fetch from a mirror (another bare clone), push to the declared o/r: lands.
    const t = setup();
    queuePr(t, 1);
    const mirror = path.join(t.tmp, 'mirror.git');
    sh(t.tmp, t.env, 'clone', '--quiet', '--mirror', t.bare, mirror);
    sh(t.work, t.env, 'remote', 'set-url', 'origin', mirror);
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', t.bare);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(lockExists(t), false, 'released to the repo it was created in');
    // A GitHub URL rewritten by insteadOf to the declared o/r: the actual (rewritten) target counts.
    const t2 = setup();
    queuePr(t2, 1);
    sh(t2.work, t2.env, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    sh(t2.work, t2.env, 'config', `url.${t2.bare.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/o/r.git');
    assert.deepEqual(runQueue(t2).merged.map((m) => m.pr), [1]);
    assert.equal(lockExists(t2), false);
  });

  test('--repo that is not origin\'s repo is refused before anything is read or changed', () => {
    const t = setup();
    const head = makePr(t, 1);
    sh(t.work, t.env, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
    const before = state(t).calls.length;
    const p = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(p.status, 2);
    assert.match(p.err, /--repo o\/r is not the repo origin pushes to \(someone\/else\)/);
    assert.doesNotMatch(p.err, /https:\/\//, 'no URL is quoted');
    const q = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.notEqual(q.status, 0);
    assert.equal(lockExists(t), false, 'no lock created');
    assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit' || c.cmd === 'pr merge' || (c.cmd === 'api' && c.method !== 'GET')), false);
  });

  // ---- a merge confirmed after a lost lock or a timed-out merge command still ends the run

  // A mergeCmd that merges the PR (in the fake), writes a file into the lander checkout (the
  // command's own output a reset or a sweep would wipe), then steals the lock or hangs.
  const mergeThen = (t, then) => {
    fs.writeFileSync(path.join(t.work, 'scripts', 'merge-then.mjs'), [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const [pr, sha] = process.argv.slice(2);',
      'const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
      'const p = s.prs.find((x) => x.number === Number(pr));',
      "p.state = 'MERGED'; p.mergeCommit = { oid: sha };",
      'fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(s, null, 2));',
      "const lander = `${process.cwd()}-lander`;",
      "if (fs.existsSync(lander)) fs.writeFileSync(`${lander}/command-file.txt`, 'kept\\n');",
      then === 'steal' ? [
        "const g = (...a) => spawnSync('git', ['--git-dir', process.env.FAKE_GH_BARE, ...a], { encoding: 'utf8' }).stdout.trim();",
        "const lock = 'refs/heads/agent-landing-lock';",
        "const c = g('commit-tree', g('rev-parse', lock + '^{tree}'), '-m', 'agent-landing-lock host=other pid=1 at=2099-01-01T00:00:00Z ttl=45');",
        "g('update-ref', lock, c); fs.writeFileSync(process.env.STOLEN_FILE, c);",
      ].join('\n') : 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40000);',
    ].join('\n'));
    t.env.STOLEN_FILE = path.join(t.tmp, 'stolen');
  };
  const sweepCount = (t) => {
    try { return JSON.parse(fs.readFileSync(path.join(t.home, '.agents', 'state', 'land-queue.json'), 'utf8'))['o/r']?.sinceSweep ?? 0; } catch { return 0; }
  };

  for (const then of ['steal', 'hang']) {
    test(`run: merged, then ${then === 'steal' ? 'the lock was lost' : 'the merge command timed out'}: counted once, then stop (no sweep, reset or next PR)`, { timeout: 180000 }, () => {
      const t = setup({ mergeCmd: 'node scripts/merge-then.mjs {pr} {sha}', sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
      queuePr(t, 1);
      queuePr(t, 2);
      // Written after the PRs (an untracked file in the main checkout, where the merge runs).
      mergeThen(t, then);
      Object.assign(t.env, { AGENT_LAND_CMD_TIMEOUT_MS: then === 'hang' ? '4000' : '600000', AGENT_LAND_STUCK_MS: '3000' });
      const rep = runQueue(t);
      assert.deepEqual(rep.merged.map((m) => m.pr), [1], 'the confirmed merge is reported');
      assert.equal(sweepCount(t), 1, 'counted once, and no sweep ran');
      assert.equal(rep.sweep, null);
      assert.match(rep.alerts.join('\n'), /#1 merged, but .*stopped before any sweep or other landing/);
      assert.deepEqual(prOf(t, 2).labels, ['queued'], 'the next PR was not started');
      assert.ok(fs.existsSync(path.join(`${t.work}-lander`, 'command-file.txt')), 'the lander checkout was not reset or cleaned');
      assert.ok(prOf(t, 1).labels.includes('landing'), 'no label cleanup after the loss or the timeout');
      if (then === 'steal') assert.equal(lockSha(t), fs.readFileSync(t.env.STOLEN_FILE, 'utf8'), 'the other lander keeps its lock');
      else assert.ok(rep.lockRetained?.sha, 'the lock is kept while the merge command may still run');
    });
  }

  test('land-pr merge now: merged after a lost lock: MERGED, counted once, no wide sweep', { timeout: 180000 }, () => {
    const t = setup({ mergeCmd: 'node scripts/merge-then.mjs {pr} {sha}', sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    const head = makePr(t, 1);
    mergeThen(t, 'steal');
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.result, 'MERGED');
    assert.equal(out.sweep, null);
    assert.match(r.err, /#1 merged, but the landing lock was lost: no wide sweep now/);
    assert.equal(sweepCount(t), 1);
    assert.equal(lockSha(t), fs.readFileSync(t.env.STOLEN_FILE, 'utf8'));
  });

  // An overdue sweep (one that failed to run or to pause earlier) runs before land-pr merges.
  test('land-pr merge now: an overdue wide sweep runs first; red refuses with nothing merged, green merges', { timeout: 180000 }, () => {
    for (const color of ['red', 'green']) {
      const t = setup({ sweepEveryMerges: 5, wideSweep: 'node scripts/sweep.mjs' });
      const dir = path.join(t.home, '.agents', 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'land-queue.json'), JSON.stringify({ 'o/r': { merges: 5, sinceSweep: 5 } }));
      const head = makePr(t, 1);
      t.env.LAND_TEST_SWEEP = color === 'red' ? 'fail' : 'pass';
      const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
      if (color === 'red') {
        assert.equal(r.status, 2, r.err);
        assert.match(r.out, /^REFUSED an overdue wide sweep on main did not finish green/);
        assert.equal(prOf(t, 1).state, 'OPEN');
        assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
        assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1', 'the red sweep paused the repo');
      } else {
        assert.equal(r.status, 0, r.err);
        assert.match(r.out, /^MERGED/);
        assert.equal(sweepCount(t), 1, 'swept first (reset to 0), then this merge counted');
      }
      assert.equal(lockExists(t), false);
    }
  });

  test('run: a failed setup after the rebase is not retried and never lands, even if the gate would pass', { timeout: 180000 }, () => {
    const t = setup({ setup: ['node scripts/fail-setup.mjs'] });
    fs.writeFileSync(path.join(t.work, 'scripts', 'fail-setup.mjs'), 'process.exit(1);\n');
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /affected gate failed: setup\[0\] .* exit 1, after the rebase/);
    assert.doesNotMatch(rep.bounced[0].reason, /retried/);
    assert.equal(fs.existsSync(`${t.env.LAND_TEST_GATE}.runs`), false, 'the affected gate was not run on its own');
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    assert.doesNotMatch(prOf(t, 1).body, /Gate: pending/);
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  // --repo spellings that differ only in case are one repo: its sweep counts are one record, and
  // counts already written under another spelling are kept (added), so a due sweep is not lost.
  test('sweep counts: case variants of --repo share one record; existing alias counts are folded in', { timeout: 180000 }, () => {
    const t = setup({ sweepEveryMerges: 4, wideSweep: 'node scripts/sweep.mjs' });
    const file = path.join(t.home, '.agents', 'state', 'land-queue.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ 'O/R': { merges: 3, sinceSweep: 3 }, 'o/r': { merges: 1, sinceSweep: 1 }, 'x/y': { merges: 7, sinceSweep: 2 } }));
    queuePr(t, 1);
    t.env.LAND_TEST_SWEEP = 'pass';
    // 3 + 1 = 4: the sweep is due, so it runs first; then the merge counts 1.
    const first = tool(t, LAND_QUEUE, 'run', '--repo', 'O/r', '--json');
    assert.equal(first.status, 0, first.err || first.out);
    assert.deepEqual(JSON.parse(first.out).merged.map((m) => m.pr), [1]);
    let s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(s).sort(), ['o/r', 'x/y'], 'one record per repo; other repos untouched');
    assert.equal(s['o/r'].merges, 5);
    assert.equal(s['o/r'].sinceSweep, 1, 'swept (to 0) before the merge, then counted');
    assert.deepEqual(s['x/y'], { merges: 7, sinceSweep: 2 });
    // Another spelling adds to the same record.
    queuePr(t, 2);
    const second = tool(t, LAND_QUEUE, 'run', '--repo', 'o/R', '--json');
    assert.equal(second.status, 0, second.err || second.out);
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(s).sort(), ['o/r', 'x/y']);
    assert.equal(s['o/r'].merges, 6);
    assert.equal(s['o/r'].sinceSweep, 2);
  });

  test('run: a stale lock is reported, not reclaimed, without --reclaim-stale', () => {
    const t = setup();
    queuePr(t, 1);
    setLock(t, 120);
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.equal(rep.stale.length, 1);
    assert.equal(rep.stale[0].host, 'other-host');
    assert.equal(lockExists(t), true);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    const again = runQueue(t, '--reclaim-stale');
    assert.equal(again.merged.length, 1);
    assert.match(again.alerts[0], /reclaimed a stale landing lock/);
    assert.equal(lockExists(t), false);
  });

  test('run: a fresh lock held by another lander means busy, nothing touched', () => {
    const t = setup();
    queuePr(t, 1);
    setLock(t, 1);
    const rep = runQueue(t, '--reclaim-stale');
    assert.equal(rep.busy, true);
    assert.equal(rep.merged.length, 0);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
  });

  test('run: queue-hold PRs (full stop) and unmet Depends-on are skipped', () => {
    const t = setup();
    queuePr(t, 1, { labels: ['queue-hold'] });
    queuePr(t, 2, { body: 'Depends-on: #1' });
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.deepEqual(rep.held, [1]);
    assert.deepEqual(rep.waiting, [{ pr: 2, dependsOn: [1] }]);
    assert.equal(prOf(t, 1).state, 'OPEN');
  });

  test('run: a red wide sweep pauses the repo (a repo variable, not a label); unpause needs green', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    queuePr(t, 1, { priority: 1 });
    queuePr(t, 2, { priority: 2 });
    t.env.LAND_TEST_SWEEP = 'fail';
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(rep.sweep.ok, false);
    assert.equal(rep.paused, true);
    assert.match(rep.alerts[0], /wide sweep on main failed.*AGENT_LANDING_PAUSED/);
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
    assert.deepEqual(prOf(t, 2).labels, ['queued'], 'no queue-hold label');
    const again = runQueue(t);
    assert.equal(again.paused, true);
    assert.equal(again.merged.length, 0);
    const still = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(still.status, 1);
    assert.equal(JSON.parse(still.out).paused, true);
    t.env.LAND_TEST_SWEEP = 'pass';
    const ok = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(ok.status, 0, ok.err);
    assert.equal(JSON.parse(ok.out).paused, false);
    assert.equal('AGENT_LANDING_PAUSED' in state(t).variables, false);
    assert.deepEqual(runQueue(t).merged.map((m) => m.pr), [2]);
  });

  test('run: admits queue-waiting PRs, oldest first, as capacity frees', () => {
    const t = setup({ maxQueued: 1 });
    queuePr(t, 1);
    for (const n of [2, 3]) {
      queuePr(t, n, { queuedAt: `2026-11-06T0${5 - n}:00:00Z` });
      const s = state(t); s.prs.find((p) => p.number === n).labels = ['queue-waiting']; saveState(t, s);
    }
    const rep = runQueue(t);
    assert.deepEqual(rep.admitted, [3, 2]);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1, 3, 2]);
    assert.deepEqual(rep.queueWaiting, []);
  });

  test('run: a waiting PR whose head changed is bounced at admission', () => {
    const t = setup({ maxQueued: 1 });
    queuePr(t, 2);
    const s = state(t); s.prs.find((p) => p.number === 2).labels = ['queue-waiting']; saveState(t, s);
    fs.writeFileSync(path.join(t.work, 'late.txt'), 'late\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'late');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-2-change');
    const rep = runQueue(t);
    assert.deepEqual(rep.admitted, []);
    assert.match(rep.bounced[0].reason, /head changed while waiting/);
    assert.deepEqual(prOf(t, 2).labels, ['queue-blocked']);
  });

  test('run: paused repo merges nothing', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    const rep = runQueue(t);
    assert.equal(rep.paused, true);
    assert.equal(rep.merged.length, 0);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
  });

  for (const [act, check] of [
    ['hold', (t, rep, head) => {
      assert.match(rep.aborted[0].reason, /queue-hold appeared before the push/);
      assert.deepEqual(prOf(t, 1).labels.sort(), ['queue-hold', 'queued']);
      assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    }],
    ['pause', (t, rep, head) => {
      assert.equal(rep.paused, true);
      assert.match(rep.aborted[0].reason, /repo paused before the push/);
      assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    }],
    ['move', (t, rep) => {
      // The re-check aborts (back to queued); the next round finds the head is not the gated sha.
      assert.match(rep.aborted[0].reason, /head changed to \w+ before the push/);
      assert.match(rep.bounced[0].reason, /head changed after the gate/);
      assert.deepEqual(prOf(t, 1).labels, ['queue-blocked']);
    }],
    ['dep', (t, rep) => {
      assert.match(rep.aborted[0].reason, /Depends-on #99 not merged before the push/);
      assert.deepEqual(prOf(t, 1).labels, ['queued']);
      assert.deepEqual(rep.waiting, [{ pr: 1, dependsOn: [99] }]);
    }],
  ]) {
    test(`run: re-check before the push aborts the landing (${act})`, () => {
      const t = setup();
      const head = queuePr(t, 1);
      advanceMain(t, 'other.txt', 'x\n');
      t.env.LAND_TEST_GATE_ACTION = `${act}:1`;
      const rep = runQueue(t);
      assert.equal(rep.merged.length, 0);
      assert.equal(prOf(t, 1).state, 'OPEN');
      assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
      assert.equal(lockExists(t), false);
      check(t, rep, head);
    });
  }

  test('run: a PR retargeted mid-gate is aborted, then bounced: its gate ran against the old base', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    sh(t.bare, t.env, 'branch', 'other', 'main');
    const otherBefore = sh(t.bare, t.env, 'rev-parse', 'refs/heads/other');
    t.env.LAND_TEST_GATE_ACTION = 'retarget:1';
    const rep = runQueue(t);
    assert.match(rep.aborted[0].reason, /base changed to other before the push/);
    // The next pass never lands it on the new base on the old proof: a new gate and land-pr first.
    assert.match(rep.bounced[0].reason, /the PR targets other, but its gate ran against main/);
    assert.deepEqual(rep.merged, []);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/other'), otherBefore, 'nothing merged into other');
    assert.notEqual(otherBefore, head);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 1);
  });

  test('run: a lost lock stops the gate at once; the replacement lock, the PR labels and the checkout are left alone', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    // The gate would run 40 s; another lander takes the lock at its start; refresh every 200 ms.
    Object.assign(t.env, { LAND_TEST_GATE_ACTION: 'steal:1', LAND_TEST_GATE_SLEEP_MS: '40000', AGENT_LAND_TICK_MS: '200' });
    const started = Date.now();
    const rep = runQueue(t);
    assert.ok(Date.now() - started < 30000, 'the gate was stopped, not waited for');
    assert.equal(rep.merged.length, 0);
    assert.match(rep.aborted[0].reason, /landing lock was lost/);
    assert.match(rep.alerts.join('\n'), /lock was lost while landing #1; stopped/);
    // Not ours to relabel any more: the next lander's leftover recovery handles `landing`.
    assert.deepEqual(prOf(t, 1).labels, ['landing']);
    assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset');
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    assert.equal(lockSha(t), fs.readFileSync(`${t.env.LAND_TEST_GATE}.stolen`, 'utf8'), 'the other lander keeps its lock');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  // Ownership decides before any other reason: a gate that ends right after another lander took
  // the lock (no refresh tick in between) and the PR changed too must still leave everything alone.
  for (const [name, act, fail] of [['made a draft', 'steal+draft:1', false], ['put on hold', 'steal+hold:1', false], ['red gate', 'steal:1', true]]) {
    test(`run: lock stolen during the gate, ${name}: no bounce, label change, reset or push`, () => {
      const t = setup();
      const head = queuePr(t, 1);
      advanceMain(t, 'other.txt', 'x\n');
      t.env.LAND_TEST_GATE_ACTION = act;
      if (fail) fs.writeFileSync(t.env.LAND_TEST_GATE, 'fail');
      const before = state(t).calls.length;
      const rep = runQueue(t);
      assert.equal(rep.merged.length, 0);
      assert.equal(rep.bounced.length, 0, 'no bounce after a lost lock');
      assert.match(rep.aborted[0].reason, /landing lock was lost/);
      assert.deepEqual(prOf(t, 1).labels.filter((l) => l !== 'queue-hold'), ['landing'], 'labels untouched');
      const s = state(t);
      assert.equal(s.calls.slice(before).some((c) => c.cmd === 'pr merge'), false);
      assert.equal((s.comments || []).length, 0, 'no bounce comment');
      assert.doesNotMatch(prOf(t, 1).body, /Bounced:/);
      assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
      assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset');
      assert.equal(lockSha(t), fs.readFileSync(`${t.env.LAND_TEST_GATE}.stolen`, 'utf8'), 'the other lander keeps its lock');
    });
  }

  // A pre-push hook (shared by the main and the lander checkout) that rejects every push while
  // the file <tmp>/reject-push exists; the test's own setup pushes run without it.
  const rejectPush = (t, on = true) => {
    const hook = path.join(t.work, '.git', 'hooks', 'pre-push');
    const flag = path.join(t.tmp, 'reject-push');
    t.env.REJECT_PUSH_FLAG = flag;
    fs.writeFileSync(hook, '#!/bin/sh\nif [ -f "$REJECT_PUSH_FLAG" ]; then echo "pre-push: rejected by the repo hook" >&2; exit 1; fi\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    if (on) fs.writeFileSync(flag, ''); else fs.rmSync(flag, { force: true });
  };

  test('run: a rejecting pre-push hook does not keep the lock after a merge; PR pushes still run the hook', () => {
    const t = setup();
    queuePr(t, 1);
    rejectPush(t);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(rep.lockRetained, undefined);
    assert.equal(lockExists(t), false, 'the lock release skips the hook');
    // A rebased head is PR content: its push keeps the repo hook, which rejects it.
    rejectPush(t, false);
    queuePr(t, 2);
    advanceMain(t, 'other.txt', 'x\n');
    rejectPush(t);
    const again = runQueue(t);
    assert.match(again.bounced[0].reason, /push of the rebased head was rejected/);
    assert.equal(lockExists(t), false);
  });

  test('run: with a rejecting pre-push hook, another lander\'s replacement lock is still never deleted', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    rejectPush(t);
    t.env.LAND_TEST_GATE_ACTION = 'steal:1';
    const rep = runQueue(t);
    assert.match(rep.aborted[0].reason, /landing lock was lost/);
    assert.equal(lockSha(t), fs.readFileSync(`${t.env.LAND_TEST_GATE}.stolen`, 'utf8'));
  });

  test('a lock that cannot be released is reported, by the lander and by merge-now', () => {
    const t = setup();
    queuePr(t, 1);
    // Pushes to origin fail (the lease delete included); the GitHub API still answers. The push
    // destination is declared as the fake o/r, so it passes the destination check.
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', path.join(t.tmp, 'no such remote.git'));
    t.env.AGENT_LAND_TEST_FAKE_GITHUB = `o/r=${path.join(t.tmp, 'no such remote.git')}`;
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.ok(rep.lockRetained?.sha);
    assert.match(rep.alerts.join('\n'), /landing lock could not be released.*git push --no-verify --force-with-lease=refs\/heads\/agent-landing-lock:[0-9a-f]{40} origin :refs\/heads\/agent-landing-lock/);
    assert.equal(lockExists(t), true);
    // The printed command deletes only that lock: with origin reachable again, a replacement lock
    // (another lander's) survives it; the retained one is deleted by it.
    const cmd = rep.alerts.join('\n').match(/remove it with: (git push \S+ \S+ origin :refs\/heads\/agent-landing-lock)/)[1].split(' ');
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', t.bare);
    const retained = lockSha(t);
    setLock(t, 0);
    const replacement = lockSha(t);
    const refused = spawnSync(cmd[0], cmd.slice(1), { cwd: t.work, env: t.env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'the lease refuses a lock that changed');
    assert.equal(lockSha(t), replacement, 'the replacement holder keeps its lock');
    sh(t.bare, t.env, 'update-ref', 'refs/heads/agent-landing-lock', retained);
    const ok = spawnSync(cmd[0], cmd.slice(1), { cwd: t.work, env: t.env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(lockExists(t), false, 'the retained lock is deleted');
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', path.join(t.tmp, 'no such remote.git'));
    const t2 = setup();
    const head = makePr(t2, 2);
    sh(t2.work, t2.env, 'remote', 'set-url', '--push', 'origin', path.join(t2.tmp, 'no such remote.git'));
    t2.env.AGENT_LAND_TEST_FAKE_GITHUB = `o/r=${path.join(t2.tmp, 'no such remote.git')}`;
    const r = tool(t2, LAND_PR, '2', '--sha', head, '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out).result, 'MERGED');
    assert.ok(JSON.parse(r.out).lockRetained?.sha);
    assert.match(r.err, /WARNING: the landing lock could not be released/);
  });

  test('run: a registered, dirty checkout at the lander path is refused with its work intact', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const dir = `${t.work}-lander`;
    sh(t.work, t.env, 'worktree', 'add', '--quiet', '--detach', dir, 'origin/main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'my tracked edit\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'my notes\n');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.out).error, /refusing to use .* it has 2 changed or untracked file\(s\); it was left untouched/);
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'my tracked edit\n');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'my notes\n');
    assert.doesNotMatch(sh(t.work, t.env, 'worktree', 'list', '--porcelain'), /land-queue lander checkout/, 'not locked by the lander');
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(lockExists(t), false);
  });

  test('run: a timed-out gate\'s detached child (own process group) is found and stopped too', { timeout: 180000 }, () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    Object.assign(t.env, { LAND_TEST_GATE_HANG: 'detached', AGENT_LAND_CMD_TIMEOUT_MS: '3000' });
    let child = 0;
    try {
      const rep = runQueue(t);
      child = Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}.child`, 'utf8'));
      let alive = true;
      try { process.kill(child, 0); } catch { alive = false; }
      // Either it was stopped and the lock released, or (never both) it survived and the lock was kept.
      assert.equal(alive, false, 'the detached child was stopped');
      assert.match(rep.bounced[0].reason, /timed out after/);
      assert.ok(rep.lockRetained?.sha, 'every timeout keeps the lock');
      assert.equal(lockExists(t), true);
    } finally {
      for (const f of ['.self', '.child']) {
        try { process.kill(Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}${f}`, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  test('run: an unrelated process in the lander checkout is never killed; the lock is kept instead', { timeout: 240000 }, () => {
    const t = setup();
    queuePr(t, 1);
    runQueue(t); // creates the lander checkout
    const dir = `${t.work}-lander`;
    // Not started by any gate: it only runs in the checkout (its cwd, and an argument inside it).
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', path.join(dir, 'marker')], { cwd: dir, stdio: 'ignore', detached: true });
    other.unref();
    try {
      queuePr(t, 2);
      advanceMain(t, 'other.txt', 'x\n');
      Object.assign(t.env, { LAND_TEST_GATE_HANG: '1', AGENT_LAND_CMD_TIMEOUT_MS: '3000' });
      const rep = runQueue(t);
      let alive = true;
      try { process.kill(other.pid, 0); } catch { alive = false; }
      assert.equal(alive, true, 'the unrelated process survives');
      const child = Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}.child`, 'utf8'));
      let childAlive = true;
      try { process.kill(child, 0); } catch { childAlive = false; }
      assert.equal(childAlive, false, 'the gate\'s own child was stopped');
      assert.ok(rep.lockRetained?.sha, 'nothing proves the checkout is free: the lock is kept');
      assert.equal(lockExists(t), true);
    } finally {
      try { process.kill(other.pid, 'SIGKILL'); } catch { /* gone */ }
      for (const f of ['.self', '.child']) {
        try { process.kill(Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}${f}`, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  test('run: a timeout keeps the lock even when a detached worker escaped before it (orphaned by its parent)', { timeout: 180000 }, () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    Object.assign(t.env, { LAND_TEST_GATE_HANG: 'orphan', AGENT_LAND_CMD_TIMEOUT_MS: '4000' });
    try {
      const rep = runQueue(t);
      assert.match(rep.bounced[0].reason, /timed out after/);
      assert.ok(rep.lockRetained?.sha, 'the lock is kept: the orphaned worker cannot be ruled out');
      assert.equal(lockExists(t), true);
      assert.match(rep.alerts.join('\n'), /landing lock is kept/);
    } finally {
      for (const f of ['.self', '.child']) {
        try { process.kill(Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}${f}`, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  test('run: a failed bounce comment leaves the PR blocked, never queued again', () => {
    const t = setup();
    queuePr(t, 1, { file: 'README.md', content: 'line one\nPR EDIT\nline three\n' });
    advanceMain(t, 'README.md', 'line one\nMAIN EDIT\nline three\n');
    const s = state(t); s.failComment = 1; saveState(t, s);
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1);
    assert.deepEqual(prOf(t, 1).labels, ['queue-blocked']);
    assert.equal(lockExists(t), false);
  });

  test('run: a merge whose read-back fails is still counted as merged, not requeued', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.failViewAfterMerge = 1; saveState(t, s);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.match(rep.alerts.join('\n'), /#1 merged, but reading it back failed/);
    assert.equal(prOf(t, 1).state, 'MERGED');
    assert.deepEqual(prOf(t, 1).labels, []);
    const counts = path.join(t.home, '.agents', 'state', 'land-queue.json');
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].merges, 1);
  });

  // SHAs in the Landing section count whatever their case: GitHub and git print lower case.
  test('run: upper-case SHAs in Gate: pass and Gate: pending lines are the same heads', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t);
    const p = s.prs.find((x) => x.number === 1);
    p.body = p.body.replace(/(Gate: pass @ )([0-9a-f]{40})/, (_, a, sha) => a + sha.toUpperCase());
    saveState(t, s);
    assert.match(prOf(t, 1).body, /Gate: pass @ [0-9A-F]{40}/);
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    // A pending line written in upper case is recognised as the pushed gated head too.
    const t2 = setup();
    queuePr(t2, 1);
    advanceMain(t2, 'other.txt', 'x\n');
    const s2 = state(t2); s2.failBodyEditMatching = '(lander rebase)'; saveState(t2, s2);
    assert.equal(tool(t2, LAND_QUEUE, 'run', '--repo', 'o/r', '--json').status, 1);
    const s3 = state(t2);
    const p3 = s3.prs.find((x) => x.number === 1);
    p3.body = p3.body.replace(/(Gate: pending @ )([0-9a-f]{40})/, (_, a, sha) => a + sha.toUpperCase());
    saveState(t2, s3);
    const rep2 = runQueue(t2);
    assert.deepEqual(rep2.bounced, []);
    assert.deepEqual(rep2.merged.map((m) => m.pr), [1]);
  });

  test('lock: a busy lock makes no lock commit while waiting', () => {
    const t = setup();
    const head = makePr(t, 1);
    setLock(t, 0);
    t.env.AGENT_LAND_LOCK_WAIT_MS = '600';
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2);
    assert.match(r.out, /^REFUSED the landing lock stayed busy/);
    assert.equal(state(t).calls.some((c) => c.cmd === 'api' && c.method === 'POST' && c.route === 'commits'), false, 'no commit made for a known busy lock');
  });

  for (const kind of ['own', 'foreign']) {
    test(`lock: a create whose answer is lost: ${kind === 'own' ? 'our own ref is adopted and released' : 'another holder\'s ref is never adopted'}`, () => {
      const t = setup();
      queuePr(t, 1);
      const s = state(t); s.refCreateLostAnswer = kind; saveState(t, s);
      const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
      const rep = JSON.parse(r.out);
      if (kind === 'own') {
        assert.equal(r.status, 0, r.err);
        assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
        assert.equal(lockExists(t), false, 'adopted, then released');
      } else {
        assert.equal(rep.busy, true, 'another holder: busy');
        assert.deepEqual(rep.merged, []);
        assert.equal(lockSha(t), state(t).foreignLock, 'the other holder keeps its lock');
      }
    });
  }

  test('unpause needs no landing gate (only the wide sweep), and clears the pause while it still holds the lock', () => {
    const t = setup({ gate: [], affectedGate: [], wideSweep: 'node scripts/sweep.mjs' });
    const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    const r = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err || r.out);
    assert.equal(JSON.parse(r.out).paused, false);
    assert.equal('AGENT_LANDING_PAUSED' in state(t).variables, false);
    assert.equal(state(t).pauseClearedWithLock, true, 'cleared before the lock was released');
    assert.equal(lockExists(t), false);
  });

  test('run: a pushed rebased head whose gate line was not written is recognised next run (no bounce)', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const s = state(t); s.failBodyEditMatching = '(lander rebase)'; saveState(t, s);
    const first = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(first.status, 1, 'the run reports the failed edit');
    assert.deepEqual(prOf(t, 1).labels, ['queued'], 'back in line, not blocked');
    assert.match(prOf(t, 1).body, /Gate: pending @ [0-9a-f]{40} \(lander rebase, push started\) base=main/);
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(parseLanding(prOf(t, 1).body).bounces.length, 0, 'no fix attempt used');
    assert.match(prOf(t, 1).body, /Gate: pass @ [0-9a-f]{40} \(lander rebase\) base=main/, 'the recovered pass line keeps its base');
  });

  // Recovery after an error reads the PR again; another lander can take the lock during that
  // read. Ownership is checked after the read, right before any change: nothing is changed.
  test('run: lock taken during the recovery read after an error: body, labels, checkout and the foreign lock untouched', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    // The pending-line edit fails; reads of #1: 1 the re-check before the push, 2 the recovery read.
    const s = state(t);
    s.failBodyEditMatching = 'push started';
    s.mutateAfter = { kind: 'prView', n: 2, pr: 1, steal: true };
    saveState(t, s);
    const bodyBefore = prOf(t, 1).body;
    const first = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(first.status, 1, 'the run reports the failed edit');
    const after = state(t);
    assert.ok(after.mutateAfter.stolen, 'the lock was taken during the recovery read');
    assert.deepEqual(prOf(t, 1).labels, ['landing'], 'labels untouched: the next lander recovers `landing`');
    assert.equal(prOf(t, 1).body, bodyBefore, 'body untouched');
    assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset');
    assert.equal(lockSha(t), after.mutateAfter.stolen, 'the other lander keeps its lock');
  });

  // The reads and fetches before the rebase take time; another lander can take the lock in that
  // window. The lander checkout is reset to the PR head only while the lock is still ours.
  test('run: lock taken before the rebase checkout reset: checkout, labels and the foreign lock untouched', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    // Lock reads: 1 the acquire, 2 landOne's first check, 3 the check right before the reset.
    const s = state(t); s.mutateAfter = { kind: 'lockGet', n: 3, pr: 1, steal: true }; saveState(t, s);
    const rep = runQueue(t);
    const after = state(t);
    assert.ok(after.mutateAfter.stolen, 'the lock was taken before the reset');
    assert.deepEqual(rep.aborted, [{ pr: 1, reason: 'the landing lock was lost before the rebase' }]);
    assert.deepEqual(rep.merged, []);
    assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), head, 'the checkout was not reset to the PR head');
    assert.deepEqual(prOf(t, 1).labels, ['landing'], 'labels untouched: the next lander recovers `landing`');
    assert.equal(lockSha(t), after.mutateAfter.stolen, 'the other lander keeps its lock');
  });

  // Leftover recovery lists the queue under the lock; another lander can take the lock during
  // that read, and its own PR then carries `landing`: it is not reset.
  test('run: lock taken during the leftover-recovery list read: the `landing` PR is not reset', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t);
    s.prs.find((p) => p.number === 1).labels = ['landing'];
    // List reads (landing, then queued): 1-2 the check for leftovers (no lock yet), 3-4 the
    // recovery's own read under the lock; the lock moves at the end of that read.
    s.mutateAfter = { kind: 'prList', n: 4, pr: 1, steal: true };
    saveState(t, s);
    const rep = runQueue(t);
    const after = state(t);
    assert.ok(after.mutateAfter.stolen, 'the lock was taken during the recovery read');
    assert.deepEqual(rep.reset, []);
    assert.deepEqual(rep.merged, []);
    assert.match(rep.alerts.join('\n'), /lock was lost while resetting leftover/);
    assert.deepEqual(prOf(t, 1).labels, ['landing']);
    assert.equal(lockSha(t), after.mutateAfter.stolen, 'the other lander keeps its lock');
  });

  // A fork PR whose branch name and head sha match an origin branch: that branch is not the
  // PR's. The lander refuses the PR before any fetch, so the origin branch is never rewritten.
  test('run: a fork PR is bounced before any fetch; the same-named origin branch is untouched; others still land', () => {
    const t = setup();
    const head = queuePr(t, 1);
    queuePr(t, 2);
    const s = state(t); s.prs.find((p) => p.number === 1).isCrossRepository = true; saveState(t, s);
    advanceMain(t, 'other.txt', 'x\n');
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced.map((b) => b.pr), [1]);
    assert.match(rep.bounced[0].reason, /from a fork/);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'the origin branch is not rewritten');
    assert.deepEqual(rep.merged.map((m) => m.pr), [2], 'an internal PR still lands');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge' && c.pr === 1), false);
  });

  test('land-pr refuses a fork PR and changes nothing', () => {
    const t = setup();
    const head = makePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).isCrossRepository = true; saveState(t, s);
    const before = state(t).calls.length;
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 2, r.err);
    assert.match(r.out, /^REFUSED the PR is from a fork/);
    assert.deepEqual(prOf(t, 1).labels, []);
    assert.equal(state(t).calls.slice(before).some((c) => c.cmd === 'pr edit' || c.cmd === 'pr merge'), false);
  });

  // An error on a later PR stops the run, but what happened before it is still reported (JSON
  // and text) with the error, and the exit is non-zero.
  test('run: an error on a later PR keeps the earlier merge and bounce in the report', () => {
    const t = setup();
    queuePr(t, 1);
    queuePr(t, 2);
    queuePr(t, 3);
    const s = state(t);
    // #2: its gated sha is not its head (a bounce); #3: needs a rebase after #1 merges, and its
    // pending-line edit fails (an error with no merge).
    const p2 = s.prs.find((p) => p.number === 2);
    p2.body = p2.body.replace(/Gate: pass @ [0-9a-f]{40}/, `Gate: pass @ ${'0'.repeat(40)}`);
    s.failBodyEditMatching = 'push started';
    saveState(t, s);
    const j = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(j.status, 1, 'non-zero exit');
    const rep = JSON.parse(j.out);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1], 'the earlier merge is kept');
    assert.deepEqual(rep.bounced.map((b) => b.pr), [2], 'the earlier bounce is kept');
    assert.match(rep.error, /502|Bad Gateway|failed/i);
    assert.equal(prOf(t, 3).state, 'OPEN');
    // The text form too (a fresh repo state for a second run is not needed: replay the same shape).
    const t2 = setup();
    queuePr(t2, 1);
    queuePr(t2, 2);
    const s2 = state(t2); s2.failBodyEditMatching = 'push started'; saveState(t2, s2);
    const txt = tool(t2, LAND_QUEUE, 'run', '--repo', 'o/r');
    assert.equal(txt.status, 1);
    assert.match(txt.out, /MERGED #1/);
    assert.match(txt.out, /ERROR .*the run stopped here; the results above stand/);
  });

  test('run: GitHub still showing the head before the lander rebase is never a bounce', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    // After the lander's push, GitHub keeps showing the old head for a long while.
    const s = state(t); s.staleHead = { pr: 1, sha: head, n: 1000 }; saveState(t, s);
    const first = runQueue(t);
    assert.match(first.aborted[0].reason, /GitHub has not shown the pushed head yet/);
    // The next run still sees the old head; the branch on origin has the gated one.
    const second = runQueue(t);
    assert.match(second.aborted[0].reason, /GitHub still shows the head before the lander rebase/);
    for (const rep of [first, second]) assert.deepEqual(rep.bounced, []);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(parseLanding(prOf(t, 1).body).bounces.length, 0, 'no fix attempt used');
    // GitHub catches up: it lands.
    const s2 = state(t); delete s2.staleHead; saveState(t, s2);
    assert.deepEqual(runQueue(t).merged.map((m) => m.pr), [1]);
  });

  test('a 422 with no lock present: retried, and an error (not a busy lock) when it persists', () => {
    const t = setup();
    const head = makePr(t, 1);
    t.env.AGENT_LAND_LOCK_WAIT_MS = '200';
    // One 422 with no holder (it released between create and read): the next try takes the lock.
    let s = state(t); s.refFail422 = 1; saveState(t, s);
    const ok = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(ok.status, 0, ok.err);
    assert.match(ok.out, /^MERGED/);
    // A create that keeps failing is a config/API error, reported at once, not a busy lock.
    const head2 = makePr(t, 2);
    s = state(t); s.refFail422 = 99; saveState(t, s);
    const bad = tool(t, LAND_PR, '2', '--sha', head2, '--repo', 'o/r');
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.err, /could not create the landing lock ref \(HTTP 422 with no lock present, 3 tries\)/);
    assert.doesNotMatch(bad.out, /busy/);
    s = state(t); s.refFail422 = 99; saveState(t, s);
    queuePr(t, 3);
    const q = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(q.status, 1);
    assert.match(JSON.parse(q.out).error, /could not create the landing lock ref/);
    // The run's report is kept with the error: not a busy lock, nothing merged.
    assert.equal(JSON.parse(q.out).busy, false);
    assert.deepEqual(JSON.parse(q.out).merged, []);
  });

  test('run: an overdue sweep that cannot run stops the run before any merge, stays due, and is retried first', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs | tee x' });
    const dir = path.join(t.home, '.agents', 'state');
    fs.mkdirSync(dir, { recursive: true });
    const counts = path.join(dir, 'land-queue.json');
    fs.writeFileSync(counts, JSON.stringify({ 'o/r': { merges: 5, sinceSweep: 5 } }));
    queuePr(t, 1);
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0, 'nothing lands while the overdue sweep cannot run');
    assert.match(rep.alerts.join('\n'), /wide sweep could not run: .*it stays due, nothing more lands/);
    assert.equal(rep.paused, false, 'no pause invented');
    assert.equal(state(t).variables?.AGENT_LANDING_PAUSED, undefined);
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].sinceSweep, 5, 'still due');
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(lockExists(t), false);
    // Still broken: still nothing lands. Fixed: the sweep runs first, then the PR lands.
    assert.equal(runQueue(t).merged.length, 0);
    const cfgFile = path.join(t.work, '.agents', 'repo.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), wideSweep: 'node scripts/sweep.mjs' }));
    const fixed = runQueue(t);
    assert.equal(fixed.sweep.ran, true);
    assert.equal(fixed.sweep.ok, true);
    assert.deepEqual(fixed.merged.map((m) => m.pr), [1]);
  });

  test('run: a red sweep whose pause cannot be set stays due, lands nothing more, and runs first next time', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    queuePr(t, 1, { priority: 1 });
    queuePr(t, 2, { priority: 2 });
    t.env.LAND_TEST_SWEEP = 'fail';
    let s = state(t); s.variablesWriteFail = true; saveState(t, s);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1], 'the merge before the sweep counts');
    assert.equal(prOf(t, 1).state, 'MERGED');
    assert.deepEqual(prOf(t, 1).labels, [], 'the merged PR is not put back in line');
    assert.match(rep.alerts.join('\n'), /the pause could not be set.*sweep runs again first/);
    assert.deepEqual(prOf(t, 2).labels, ['queued'], 'nothing more landed');
    assert.equal(prOf(t, 2).state, 'OPEN');
    const counts = path.join(t.home, '.agents', 'state', 'land-queue.json');
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].sinceSweep, 1, 'still due');
    assert.equal(lockExists(t), false);
    // Next run: the sweep runs before any landing; this time the pause holds.
    s = state(t); delete s.variablesWriteFail; saveState(t, s);
    const next = runQueue(t);
    assert.equal(next.sweep.ran, true);
    assert.equal(next.paused, true);
    assert.equal(next.merged.length, 0);
    assert.equal(prOf(t, 2).state, 'OPEN');
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
  });

  test('a bounce reason is scrubbed once, for the PR body, the comment and the report alike', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const t = setup({ affectedGate: [`node scripts/gate.mjs --token=${token}`] });
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    fs.writeFileSync(t.env.LAND_TEST_GATE, 'fail');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.match(prOf(t, 1).body, /Bounced: .*\[redacted\]/);
    for (const [where, text] of [['body', prOf(t, 1).body], ['comment', state(t).comments.map((c) => c.body).join('\n')], ['report', r.out]]) {
      assert.doesNotMatch(text, new RegExp(token), `${where} has no token`);
    }
  });

  test('a draft PR stays queued but is not landed; one made a draft mid-gate is aborted, not bounced', () => {
    const t = setup();
    queuePr(t, 1);
    let s = state(t); s.prs.find((p) => p.number === 1).isDraft = true; saveState(t, s);
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.deepEqual(rep.drafts, [1]);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    s = state(t); s.prs.find((p) => p.number === 1).isDraft = false; saveState(t, s);
    advanceMain(t, 'other.txt', 'x\n');
    t.env.LAND_TEST_GATE_ACTION = 'draft:1';
    const mid = runQueue(t);
    assert.match(mid.aborted[0].reason, /made a draft before the push/);
    assert.deepEqual(mid.bounced, []);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(parseLanding(prOf(t, 1).body).bounces.length, 0);
  });

  test('merge-now: a merge count that cannot be recorded still reports MERGED, with a warning', () => {
    const t = setup();
    const head = makePr(t, 1);
    fs.mkdirSync(path.join(t.home, '.agents', 'state', 'land-queue.json'), { recursive: true });
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^MERGED /);
    assert.match(r.err, /warning: the merge count was not updated .* the next wide sweep may run late/);
    assert.equal(prOf(t, 1).state, 'MERGED');
  });

  test('run: waiting PRs are admitted only under the landing lock', () => {
    const t = setup({ maxQueued: 2 });
    queuePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).labels = ['queue-waiting']; saveState(t, s);
    setLock(t, 1);
    const rep = runQueue(t);
    assert.equal(rep.busy, true);
    assert.deepEqual(rep.admitted, []);
    assert.deepEqual(prOf(t, 1).labels, ['queue-waiting']);
  });

  test('run: a PR whose base is not fetched yet creates the lander checkout on that base', () => {
    const t = setup();
    sh(t.bare, t.env, 'branch', 'other', 'main');
    // PR 1 targets "other", which this clone has never fetched; no lander checkout exists yet.
    const head = makePr(t, 1, { base: 'main' });
    const s = state(t);
    const p = s.prs.find((x) => x.number === 1);
    p.baseRefName = 'other';
    p.labels = ['queued'];
    // Gated against "other", the base it targets.
    p.body = writeLanding('', { gateSha: head, queuedAt: '2026-11-06T01:00:00Z', base: 'other' });
    saveState(t, s);
    spawnSync('git', ['-C', t.work, 'update-ref', '-d', 'refs/remotes/origin/other'], { env: t.env });
    assert.equal(fs.existsSync(`${t.work}-lander`), false);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
  });

  test('run: a timed-out gate that cannot be stopped keeps the lock, leaves the checkout and stops the run', { timeout: 180000 }, () => {
    const t = setup();
    queuePr(t, 1, { priority: 1 });
    queuePr(t, 2, { priority: 2 });
    advanceMain(t, 'other.txt', 'x\n');
    // The kill is simulated as failing (nothing is signalled); the test stops its own gate after.
    Object.assign(t.env, { LAND_TEST_GATE_HANG: '1', AGENT_LAND_CMD_TIMEOUT_MS: '2000', AGENT_LAND_STUCK_MS: '1500', AGENT_ENV_NO_SECRETS: '1', AGENT_LAND_TEST_NO_KILL: '1' });
    try {
      const rep = runQueue(t);
      assert.match(rep.bounced[0].reason, /timed out after .* the landing lock is kept/);
      assert.ok(rep.lockRetained?.sha, 'the lock is reported as kept');
      assert.match(rep.alerts.join('\n'), /the landing lock is kept because .* may still run.*; once that command's processes in the lander checkout have stopped and no lander run is active, remove it with: git push --no-verify --force-with-lease=/);
      assert.equal(lockExists(t), true, 'the lock outlives the command');
      assert.equal(rep.merged.length, 0);
      assert.deepEqual(prOf(t, 2).labels, ['queued'], 'the run stopped');
      assert.notEqual(sh(`${t.work}-lander`, t.env, 'rev-parse', 'HEAD'), sh(t.work, t.env, 'rev-parse', 'origin/main'), 'the checkout was not reset under the running command');
    } finally {
      for (const f of ['.self', '.child']) {
        try { process.kill(Number(fs.readFileSync(`${t.env.LAND_TEST_GATE}${f}`, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  test('run: an unlocked checkout at the lander path holding an ignored user file is refused intact', () => {
    const t = setup();
    fs.appendFileSync(path.join(t.work, '.git', 'info', 'exclude'), 'f1.txt\n');
    // The PR tracks f1.txt (force-added past the exclude), and is behind the base.
    sh(t.work, t.env, 'fetch', '--quiet', 'origin');
    sh(t.work, t.env, 'checkout', '--quiet', '-B', 'agent/LEE-1-change', 'origin/main');
    fs.writeFileSync(path.join(t.work, 'f1.txt'), 'pr bytes\n');
    sh(t.work, t.env, 'add', '-f', 'f1.txt');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'f1');
    sh(t.work, t.env, 'push', '--quiet', '-f', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    const head = sh(t.work, t.env, 'rev-parse', 'HEAD');
    const s = state(t);
    s.prs.push({ number: 1, title: 'f1', headRefName: 'agent/LEE-1-change', baseRefName: 'main', state: 'OPEN', labels: ['queued'], body: writeLanding('', { gateSha: head, queuedAt: '2026-11-06T01:00:00Z', base: 'main' }) });
    saveState(t, s);
    advanceMain(t, 'other.txt', 'x\n');
    const dir = `${t.work}-lander`;
    sh(t.work, t.env, 'worktree', 'add', '--quiet', '--detach', dir, 'origin/main');
    fs.writeFileSync(path.join(dir, 'f1.txt'), 'user bytes\n');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1, r.out);
    assert.match(JSON.parse(r.out).error, /refusing to use .* ignored file/);
    assert.equal(fs.readFileSync(path.join(dir, 'f1.txt'), 'utf8'), 'user bytes\n');
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
  });

  test('run: an unlocked checkout at the lander path with a rebase in progress is refused, its rebase kept', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const dir = `${t.work}-lander`;
    sh(t.work, t.env, 'worktree', 'add', '--quiet', '--detach', dir, 'origin/main');
    // A user's rebase that stopped (its exec step failed); the work tree itself is clean.
    spawnSync('git', ['-C', dir, 'rebase', '--exec', 'git rev-parse --verify --quiet refs/heads/no-such-branch', 'HEAD~1'], { env: t.env, encoding: 'utf8' });
    const gitDir = sh(dir, t.env, 'rev-parse', '--absolute-git-dir');
    assert.ok(fs.existsSync(path.join(gitDir, 'rebase-merge')), 'fixture: a rebase is in progress');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1, r.out);
    assert.match(JSON.parse(r.out).error, /refusing to use .* in progress/);
    assert.ok(fs.existsSync(path.join(gitDir, 'rebase-merge')), 'the user\'s rebase is still there');
  });

  test('run: a leftover rebase-apply in the lander\'s own checkout is cleared before landing', () => {
    const t = setup();
    queuePr(t, 1);
    runQueue(t);
    const dir = `${t.work}-lander`;
    // Leave the lander's own checkout in a stopped apply-backend rebase (a conflict).
    sh(dir, t.env, 'checkout', '--quiet', '--detach', 'origin/main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'lander side\n');
    sh(dir, t.env, 'commit', '--quiet', '-am', 'conflicting');
    advanceMain(t, 'README.md', 'main side\n');
    sh(dir, t.env, 'fetch', '--quiet', 'origin');
    spawnSync('git', ['-C', dir, '-c', 'rebase.backend=apply', 'rebase', 'origin/main'], { env: t.env, encoding: 'utf8' });
    const gitDir = sh(dir, t.env, 'rev-parse', '--absolute-git-dir');
    assert.ok(fs.existsSync(path.join(gitDir, 'rebase-apply')), 'fixture: rebase-apply left behind');
    queuePr(t, 2);
    advanceMain(t, 'other.txt', 'x\n');
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.deepEqual(rep.merged.map((m) => m.pr), [2]);
  });

  test('run: a sweep that loses the lock before any refresh stays due and stops the run', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    queuePr(t, 1, { priority: 1 });
    queuePr(t, 2, { priority: 2 });
    t.env.LAND_TEST_SWEEP = 'steal';
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.match(rep.alerts.join('\n'), /lock was lost/);
    assert.equal(rep.busy, false, 'stopped because the lock was lost, not because it was busy');
    assert.deepEqual(prOf(t, 2).labels, ['queued']);
    const counts = path.join(t.home, '.agents', 'state', 'land-queue.json');
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].sinceSweep, 1, 'still due');
    assert.ok(lockExists(t), 'the other lander keeps its lock');
  });

  test('run: an idle overdue sweep that loses the lock stays due', () => {
    const t = setup({ sweepEveryMerges: 2, wideSweep: 'node scripts/sweep.mjs' });
    const dir = path.join(t.home, '.agents', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'land-queue.json'), JSON.stringify({ 'o/r': { merges: 3, sinceSweep: 3 } }));
    t.env.LAND_TEST_SWEEP = 'steal';
    const rep = runQueue(t);
    assert.match(rep.alerts.join('\n'), /lock was lost/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'land-queue.json'), 'utf8'))['o/r'].sinceSweep, 3);
  });

  test('run: the lander rebase runs repo hooks without the 1Password token', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const out = path.join(t.tmp, 'hook out');
    t.env.HOOK_OUT = out;
    const hook = path.join(t.work, '.git', 'hooks', 'pre-rebase');
    fs.writeFileSync(hook, '#!/bin/sh\nif [ -n "$OP_SERVICE_ACCOUNT_TOKEN" ]; then echo leaked > "$HOOK_OUT"; else echo clean > "$HOOK_OUT"; fi\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'clean');
  });

  test('run: merged PRs lose every queue label', () => {
    const t = setup();
    queuePr(t, 1, { labels: ['queue-next'] });
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.deepEqual(prOf(t, 1).labels, []);
  });

  for (const kind of ['an unrelated repository', 'a link to the main checkout']) {
    test(`run: refuses ${kind} at the lander checkout path, before touching it`, (tt) => {
      const t = setup();
      queuePr(t, 1);
      advanceMain(t, 'other.txt', 'x\n');
      const dir = `${t.work}-lander`;
      if (kind === 'an unrelated repository') {
        sh(t.tmp, t.env, 'init', '--quiet', dir);
        fs.writeFileSync(path.join(dir, 'keep me.txt'), 'mine\n');
      } else {
        try { fs.symlinkSync(t.work, dir, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { tt.skip(e.code); return; }
        fs.writeFileSync(path.join(t.work, 'keep me.txt'), 'mine\n');
      }
      const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
      assert.equal(r.status, 1);
      assert.match(JSON.parse(r.out).error, /refusing to use .* as the lander checkout/);
      assert.ok(fs.existsSync(path.join(kind === 'an unrelated repository' ? dir : t.work, 'keep me.txt')), 'nothing cleaned');
      assert.deepEqual(prOf(t, 1).labels, ['queued']);
      assert.equal(lockExists(t), false);
    });
  }

  test('run: a leftover landing + queue-hold is reset first, even when the repo is paused', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t); s.prs.find((p) => p.number === 1).labels = ['landing', 'queue-hold']; s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    const rep = runQueue(t);
    assert.equal(rep.paused, true);
    assert.deepEqual(rep.reset, [1]);
    assert.deepEqual(prOf(t, 1).labels.sort(), ['queue-hold', 'queued']);
    assert.equal(lockExists(t), false);
  });

  test('run: a queue-hold PR does not block admission of a waiting PR', () => {
    const t = setup({ maxQueued: 1 });
    queuePr(t, 1, { labels: ['queue-hold'] });
    queuePr(t, 2);
    const s = state(t); s.prs.find((p) => p.number === 2).labels = ['queue-waiting']; saveState(t, s);
    const rep = runQueue(t);
    assert.deepEqual(rep.admitted, [2]);
    assert.deepEqual(rep.merged.map((m) => m.pr), [2]);
  });

  test('run: an idle lander runs an overdue wide sweep', () => {
    const t = setup({ sweepEveryMerges: 2, wideSweep: 'node scripts/sweep.mjs' });
    const dir = path.join(t.home, '.agents', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'land-queue.json'), JSON.stringify({ 'o/r': { merges: 3, sinceSweep: 3 } }));
    const rep = runQueue(t);
    assert.equal(rep.sweep.ran, true);
    assert.equal(rep.sweep.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'land-queue.json'), 'utf8'))['o/r'].sinceSweep, 0);
    assert.equal(lockExists(t), false);
  });

  test('run: a wide sweep that throws is reported, stays due and runs on the next run; the merge stands', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs | tee x' });
    queuePr(t, 1);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.match(rep.alerts.join('\n'), /wide sweep could not run.*stays due/);
    assert.equal(rep.paused, false);
    assert.equal(prOf(t, 1).state, 'MERGED');
    assert.deepEqual(prOf(t, 1).labels, []);
    assert.equal(lockExists(t), false);
    const counts = path.join(t.home, '.agents', 'state', 'land-queue.json');
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].sinceSweep, 1, 'still due');
    // Fixed config: the idle lander retries the overdue sweep.
    const cfgFile = path.join(t.work, '.agents', 'repo.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), wideSweep: 'node scripts/sweep.mjs' }));
    const again = runQueue(t);
    assert.equal(again.sweep.ran, true);
    assert.equal(again.sweep.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(counts, 'utf8'))['o/r'].sinceSweep, 0);
  });

  for (const [what, mutate, check] of [
    ['a retarget', { base: 'other' }, (t, rep, mainBefore) => {
      assert.match(rep.aborted[0].reason, /base changed to other before the merge/);
      assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/main'), mainBefore, 'nothing merged into main');
    }],
    ['a new Depends-on', { appendBody: '\nDepends-on: #99\n' }, (t, rep, mainBefore) => {
      assert.match(rep.aborted[0].reason, /Depends-on #99 not merged before the merge/);
      assert.equal(rep.merged.length, 0);
      assert.deepEqual(prOf(t, 1).labels, ['queued']);
      assert.deepEqual(rep.waiting, [{ pr: 1, dependsOn: [99] }]);
      assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/main'), mainBefore);
    }],
  ]) {
    test(`run: ${what} seen only by the last read before the merge aborts the landing`, () => {
      const t = setup();
      queuePr(t, 1);
      sh(t.bare, t.env, 'branch', 'other', 'main');
      const mainBefore = sh(t.bare, t.env, 'rev-parse', 'refs/heads/main');
      // Reads of PR #1 while it lands (no rebase): #1 is the full re-check before the base check,
      // #2 the last re-check after it. The change lands right after #1, between the two, so only
      // the last read before the merge can see it (removing that re-check makes this test fail).
      const s = state(t); s.mutateAfter = { kind: 'prView', n: 1, pr: 1, ...mutate }; saveState(t, s);
      const rep = runQueue(t);
      assert.equal(state(t).mutateAfter.seen >= 1, true);
      check(t, rep, mainBefore);
      assert.equal(lockExists(t), false);
    });
  }

  for (const wideSweep of [null, [], '   ', ['']]) {
    test(`unpause keeps the pause for wideSweep ${JSON.stringify(wideSweep)} (no command that checks anything)`, () => {
      const t = setup({ wideSweep });
      const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
      const r = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
      assert.equal(r.status, 1, r.err);
      assert.equal(JSON.parse(r.out).paused, true);
      assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
    });
  }

  test('unpause: a sweep that times out did not finish (not red); the pause stays', () => {
    const t = setup({ wideSweep: 'node scripts/sweep.mjs' });
    const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    Object.assign(t.env, { LAND_TEST_SWEEP: 'hang', AGENT_LAND_CMD_TIMEOUT_MS: '3000' });
    const r = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.paused, true);
    assert.match(out.note, /wide sweep on main did not finish \(.*timed out.*\); the pause stays/);
    assert.doesNotMatch(out.note, /still red/);
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
  });

  test('unpause keeps the pause when no wideSweep is configured (nothing shows the base is green)', () => {
    const t = setup();
    const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    const r = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.out).paused, true);
    assert.match(JSON.parse(r.out).note, /the owner clears the pause/);
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
  });

  test('unpause takes the landing lock for its sweep and refuses while it is busy', () => {
    const t = setup({ wideSweep: 'node scripts/sweep.mjs' });
    const s = state(t); s.variables = { AGENT_LANDING_PAUSED: '1' }; saveState(t, s);
    setLock(t, 1);
    const busy = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(busy.status, 1);
    assert.equal(JSON.parse(busy.out).busy, true);
    assert.equal(state(t).variables.AGENT_LANDING_PAUSED, '1');
    sh(t.bare, t.env, 'update-ref', '-d', 'refs/heads/agent-landing-lock');
    const ok = tool(t, LAND_QUEUE, 'unpause', '--repo', 'o/r', '--json');
    assert.equal(ok.status, 0, ok.err);
    assert.equal('AGENT_LANDING_PAUSED' in state(t).variables, false);
    assert.equal(lockExists(t), false);
  });

  test('run --root from another folder: a repo-relative mergeCmd runs in the repo', () => {
    const t = setup({ mergeCmd: 'node scripts/merge.mjs {pr} {sha}' });
    fs.writeFileSync(path.join(t.work, 'scripts', 'merge.mjs'), [
      "import fs from 'node:fs';",
      'const [pr, sha] = process.argv.slice(2);',
      'const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
      'const p = s.prs.find((x) => x.number === Number(pr));',
      "p.state = 'MERGED'; p.mergeCommit = { oid: sha };",
      'fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(s, null, 2));',
    ].join('\n'));
    queuePr(t, 1);
    t.cwd = t.tmp;
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--root', t.work, '--json');
    assert.equal(r.status, 0, r.err || r.out);
    assert.deepEqual(JSON.parse(r.out).merged.map((m) => m.pr), [1]);
  });

  // A mergeCmd that merges and then fails (a later step of a wrapper) still merged: counted and
  // cleaned up; one that fails without a merge stays a failure.
  for (const merges of [true, false]) {
    test(`run: a mergeCmd that exits 3 ${merges ? 'after merging is a merge' : 'without merging bounces'}`, () => {
      const t = setup({ mergeCmd: 'node scripts/merge.mjs {pr} {sha}' });
      fs.writeFileSync(path.join(t.work, 'scripts', 'merge.mjs'), [
        "import fs from 'node:fs';",
        'const [pr, sha] = process.argv.slice(2);',
        'const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
        'const p = s.prs.find((x) => x.number === Number(pr));',
        merges ? "p.state = 'MERGED'; p.mergeCommit = { oid: sha };" : '',
        'fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(s, null, 2));',
        'process.exit(3);',
      ].join('\n'));
      queuePr(t, 1);
      const rep = runQueue(t);
      if (merges) {
        assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
        assert.equal(rep.bounced.length, 0);
        assert.deepEqual(prOf(t, 1).labels.filter((l) => /^queue|^landing$/.test(l)), [], 'queue labels cleared');
        assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.HOME, '.agents', 'state', 'land-queue.json'), 'utf8'))['o/r'].sinceSweep, 1, 'counted');
      } else {
        assert.equal(rep.merged.length, 0);
        assert.match(rep.bounced[0].reason, /merge failed \(merge command exit 3\)/);
        assert.equal(prOf(t, 1).state, 'OPEN');
      }
    });
  }

  // A plain rebase drops merge commits, and with them a change made only in the merge (here an
  // edit to a file the branch already changes, so no new path): such a branch is bounced before
  // any rebase, never rebased, pushed or merged without that change.
  test('run: a branch with a merge commit (a change only in the merge) is bounced, not rebased', () => {
    const t = setup();
    makePr(t, 1, { file: 'a.txt', content: 'a1\n' });
    sh(t.work, t.env, 'checkout', '--quiet', '-B', 'side', 'origin/main');
    fs.writeFileSync(path.join(t.work, 'b.txt'), 'b\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'side');
    sh(t.work, t.env, 'checkout', '--quiet', 'agent/LEE-1-change');
    sh(t.work, t.env, 'merge', '--quiet', '--no-ff', '--no-commit', 'side');
    fs.writeFileSync(path.join(t.work, 'a.txt'), 'resolved in the merge\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '--no-edit', '-m', 'merge side');
    sh(t.work, t.env, 'push', '--quiet', '-f', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    const head = sh(t.work, t.env, 'rev-parse', 'HEAD');
    const s = state(t);
    const p = s.prs.find((x) => x.number === 1);
    p.labels = ['queued'];
    p.body = writeLanding(p.body, { gateSha: head, queuedAt: '2026-11-06T01:00:00Z', base: 'main' });
    saveState(t, s);
    advanceMain(t, 'other.txt', 'x\n');
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /1 merge commit\(s\).*rebase it onto main by hand/);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not rebased or pushed');
    assert.equal(sh(t.bare, t.env, 'show', 'agent/LEE-1-change:a.txt'), 'resolved in the merge', 'the merge-only change is kept');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('run: re-check before the merge aborts when queue-hold appears after the push', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const s = state(t); s.holdAfterLanderGate = 1; saveState(t, s);
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.aborted[0].reason, /queue-hold appeared before the merge/);
    assert.equal(prOf(t, 1).state, 'OPEN');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

  test('run: a rebase that changes a patch (range-diff not all =) bounces for re-gate', () => {
    const t = setup();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    advanceMain(t, 'ten.txt', `${lines.join('\n')}\n`);
    const pl = [...lines]; pl[5] = 'PR EDIT';
    const head = queuePr(t, 1, { file: 'ten.txt', content: `${pl.join('\n')}\n` });
    const ml = [...lines]; ml[2] = 'MAIN EDIT';
    advanceMain(t, 'ten.txt', `${ml.join('\n')}\n`);
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /the rebase changed 1 of 1 commit/);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head);
  });

  test('run: the base moves right before the merge -> rebase and validation run again, then merge', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const s = state(t); s.advanceBaseAfterLanderGate = 1; saveState(t, s);
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(sh(t.bare, t.env, 'log', '-1', '--format=%s', 'main~1'), 'base moved');
    const gates = parseLanding(prOf(t, 1).body).gates.filter((g) => /lander rebase/.test(g.note));
    assert.equal(gates.length, 2, 'rebased and gated twice');
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 2);
  });

  // The base moves before the merge, and in that window the PR is closed, made a draft, held or
  // retargeted: the retry's fresh read is checked before any work. No second rebase or gate, no
  // bounce or comment; a closed PR just loses `landing`, the others go back to queued.
  for (const [what, change, expect] of [
    ['closed', { state: 'CLOSED' }, (t, rep) => { assert.match(rep.aborted[0].reason, /PR is CLOSED before the retry/); assert.equal(prOf(t, 1).labels.includes('landing'), false); }],
    ['made a draft', { draft: true }, (t, rep) => { assert.match(rep.aborted[0].reason, /made a draft before the retry/); assert.deepEqual(prOf(t, 1).labels, ['queued']); }],
    ['put on hold', { addLabel: 'queue-hold' }, (t, rep) => { assert.match(rep.aborted[0].reason, /queue-hold appeared before the retry/); assert.deepEqual(prOf(t, 1).labels.sort(), ['queue-hold', 'queued']); }],
    // Back in line after the abort, the next pass bounces it: its gate ran against main.
    ['retargeted', { base: 'other' }, (t, rep) => {
      assert.match(rep.aborted[0].reason, /base changed to other before the retry/);
      assert.match(rep.bounced[0]?.reason || '', /the PR targets other, but its gate ran against main/);
    }],
  ]) {
    test(`run: the base moves and the PR is ${what} before the retry: no second rebase or gate, no bounce`, () => {
      const t = setup();
      queuePr(t, 1);
      sh(t.bare, t.env, 'branch', 'other', 'main');
      advanceMain(t, 'other.txt', 'x\n');
      const s = state(t); s.advanceBaseAfterLanderGate = 1; s.thenMutate = change; saveState(t, s);
      const rep = runQueue(t);
      assert.ok(state(t).mutateAfter?.seen >= 2, 'the change came in the retry window');
      if (what !== 'retargeted') {
        assert.deepEqual(rep.bounced, []);
        assert.deepEqual(state(t).comments || [], [], 'no comment');
      }
      assert.equal(sh(t.bare, t.env, 'log', '-1', '--format=%s', 'main'), 'base moved', 'nothing merged into main');
      assert.equal(rep.merged.length, 0);
      assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 1, 'gated once, not again');
      assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
      expect(t, rep);
    });
  }

  // Depends-on names this repo's PRs as #n; another repo's reference is not a local number.
  test('Depends-on another repo (owner/name#n or a URL) is not a local PR: it blocks, named as unsupported', () => {
    for (const ref of ['owner/other#12', 'https://github.com/owner/other/pull/12']) {
      const t = setup();
      queuePr(t, 1, { body: `Depends-on: ${ref}\n` });
      const rep = runQueue(t);
      assert.equal(rep.merged.length, 0, ref);
      assert.deepEqual(rep.waiting, [{ pr: 1, dependsOn: [ref] }], ref);
      const txt = tool(t, LAND_QUEUE, 'status', '--repo', 'o/r');
      assert.match(txt.out, new RegExp(`waiting #1 on ${ref.replace(/[./]/g, '\\$&')} \\(another repo: not supported`));
      const head = makePr(t, 2, { body: `Depends-on: ${ref}\n` });
      const r = tool(t, LAND_PR, '2', '--sha', head, '--repo', 'o/r');
      assert.equal(r.status, 2);
      assert.match(r.out, /^REFUSED Depends-on .*another repo: not supported/);
    }
    // #n of this repo still works.
    const t = setup();
    queuePr(t, 1, { body: 'Depends-on: #7, #8\n' });
    assert.deepEqual(runQueue(t).waiting, [{ pr: 1, dependsOn: [7, 8] }]);
  });

  // A gate is proof for the base it ran against, recorded on its line. A PR retargeted after its
  // gate never lands on the new base on that proof, in this run or a later one; a new gate and
  // land-pr on the new base (which records it) lets it land there.
  test('run: a PR retargeted after its gate is bounced (this run and the next); a fresh land-pr on the new base lands it', () => {
    const t = setup();
    const head = queuePr(t, 1);
    sh(t.bare, t.env, 'branch', 'other', 'main');
    const s = state(t); s.prs.find((p) => p.number === 1).baseRefName = 'other'; saveState(t, s);
    const first = runQueue(t);
    assert.deepEqual(first.merged, []);
    assert.match(first.bounced[0].reason, /the PR targets other, but its gate ran against main: re-gate and re-review on other/);
    const second = runQueue(t);
    assert.deepEqual(second.merged, [], 'the next run does not land it either');
    assert.equal(sh(t.bare, t.env, 'log', '-1', '--format=%s', 'other'), sh(t.bare, t.env, 'log', '-1', '--format=%s', 'main'), 'nothing merged into other');
    // The gate is run again on other (here: the same head passes), then land-pr records base=other.
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err || r.out);
    assert.match(prOf(t, 1).body, new RegExp(`Gate: pass @ ${head} base=other`));
    const third = runQueue(t);
    assert.deepEqual(third.merged.map((m) => m.pr), [1]);
  });

  test('run: a gate line without a base (older format) proves no base: bounced for a fresh gate and land-pr', () => {
    const t = setup();
    queuePr(t, 1);
    const s = state(t);
    const p = s.prs.find((x) => x.number === 1);
    p.body = p.body.replace(/ base=main/, '');
    saveState(t, s);
    const rep = runQueue(t);
    assert.deepEqual(rep.merged, []);
    assert.match(rep.bounced[0].reason, /the gate line names no base/);
  });

  test('run: a leftover landing label (crashed run) is reset to queued under the lock', () => {
    const t = setup();
    queuePr(t, 1, { labels: ['landing'] });
    let s = state(t); s.prs.find((p) => p.number === 1).labels = ['landing']; saveState(t, s);
    queuePr(t, 2, { priority: 1 });
    const rep = runQueue(t);
    assert.deepEqual(rep.reset, [1]);
    assert.deepEqual(rep.merged.map((m) => m.pr), [2, 1], 'after the reset, normal order applies');
    s = state(t);
    const edits = s.calls.filter((c) => c.cmd === 'pr edit' && c.pr === 1);
    assert.deepEqual(edits[0].add, ['queued']);
    assert.deepEqual(edits[0].remove, ['landing']);
  });

  test('run: an error mid-landing puts the PR back to queued (never left landing)', () => {
    const t = setup();
    queuePr(t, 1);
    fs.writeFileSync(`${t.work}-lander`, 'not a checkout');
    const r = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.out).error, /not a git checkout/);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(lockExists(t), false);
  });

  test('run: the third bounce parks the PR with a PARKED: comment', () => {
    const t = setup();
    const old = 'Bounced: 2026-11-05T01:00:00Z conflict';
    queuePr(t, 1);
    let s = state(t);
    const p = s.prs.find((x) => x.number === 1);
    p.body = appendLanding(appendLanding(p.body, old), old.replace('01:', '02:'));
    saveState(t, s);
    fs.writeFileSync(path.join(t.work, 'late.txt'), 'late\n');
    sh(t.work, t.env, 'add', '-A');
    sh(t.work, t.env, 'commit', '--quiet', '-m', 'late');
    sh(t.work, t.env, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agent/LEE-1-change');
    const rep = runQueue(t);
    assert.equal(rep.bounced[0].attempt, 3);
    assert.equal(rep.bounced[0].parked, true);
    assert.deepEqual(prOf(t, 1).labels, ['queue-blocked']);
    s = state(t);
    const c = s.comments.filter((x) => x.pr === 1);
    assert.equal(c.length, 1);
    assert.match(c[0].body, /^PARKED: /);
  });

  test('run: the first bounce is not parked', () => {
    const t = setup();
    queuePr(t, 1, { file: 'README.md', content: 'line one\nPR EDIT\nline three\n' });
    advanceMain(t, 'README.md', 'line one\nMAIN EDIT\nline three\n');
    const rep = runQueue(t);
    assert.equal(rep.bounced[0].parked, false);
    assert.doesNotMatch(state(t).comments[0].body, /^PARKED/);
  });

  test('run --dry-run reports the plan and changes nothing', () => {
    const t = setup();
    queuePr(t, 1);
    queuePr(t, 2, { labels: ['queue-next'] });
    const before = fs.readFileSync(t.stateFile, 'utf8');
    const rep = runQueue(t, '--dry-run');
    assert.deepEqual(rep.plan, [2, 1]);
    const s = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
    assert.deepEqual(s.prs, JSON.parse(before).prs);
    assert.equal(lockExists(t), false);
  });
});
