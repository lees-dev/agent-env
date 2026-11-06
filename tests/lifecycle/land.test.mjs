// Tests for home/dot_agents/bin/land-pr.mjs, land-queue.mjs and lib/land.mjs.
// Run: node --test "tests/lifecycle/*.test.mjs"
// Git is real (local bare "origin" plus a clone); gh is fakes/fake-gh.mjs on PATH (a .cmd shim on
// Windows, a sh shim elsewhere, so commands go through lib/proc.mjs as real ones do), backed by
// the same bare repo. Every temp path contains spaces, to cover Windows paths with spaces.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendLanding, isStale, lockMessage, orderQueue, parseLanding, parseLockMessage, rangeDiffChanges,
  registeredRepos, scrub, splitArgv, writeLanding,
} from '../../home/dot_agents/bin/lib/land.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../home/dot_agents/bin');
const LAND_PR = path.join(BIN, 'land-pr.mjs');
const LAND_QUEUE = path.join(BIN, 'land-queue.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

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
// becomes "other"), steal (another lander replaces the landing lock; its sha goes to <gate>.stolen).
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
if (act) {
  const sf = process.env.FAKE_GH_STATE;
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const pr = s.prs.find((p) => p.number === Number(n));
  if (act === 'hold') pr.labels.push('queue-hold');
  if (act === 'pause') s.variables = { ...(s.variables || {}), AGENT_LANDING_PAUSED: '1' };
  if (act === 'dep') pr.body += '\\nDepends-on: #99\\n';
  if (act === 'retarget') pr.baseRefName = 'other';
  if (act === 'move') {
    const ref = 'refs/heads/' + pr.headRefName;
    const c = g('commit-tree', g('rev-parse', ref + '^{tree}'), '-p', g('rev-parse', ref), '-m', 'moved');
    g('update-ref', ref, c);
  }
  if (act === 'steal') {
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
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('OP_') || k.toUpperCase() === 'T3CODE_THREAD_ID') delete env[k];
  env.OP_SERVICE_ACCOUNT_TOKEN = 'dummy-test-value';
  const pk = pathKey(env);
  env[pk] = `${fakebin}${path.delimiter}${env[pk] || ''}`;
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    FAKE_GH_STATE: stateFile, FAKE_GH_BARE: bare, HOME: home, USERPROFILE: home, AGENT_LAND_POLL_MS: '1',
    LAND_TEST_GATE: path.join(tmp, 'gate result'),
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
  p.body = writeLanding(p.body, { gateSha: head, queuedAt: opts.queuedAt || `2026-11-06T0${n}:00:00Z` });
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

describe('lib/land.mjs', () => {
  test('splitArgv keeps Windows paths and quoted words', () => {
    assert.deepEqual(splitArgv('node "C:\\Program Files\\x\\y.mjs" --a b'), ['node', 'C:\\Program Files\\x\\y.mjs', '--a', 'b']);
    assert.deepEqual(splitArgv("npm run 'gate:all'"), ['npm', 'run', 'gate:all']);
    assert.deepEqual(splitArgv('a "say \\"hi\\"" c'), ['a', 'say "hi"', 'c']);
    assert.throws(() => splitArgv('a "b'));
  });

  test('Landing section: write, append, parse; other text kept', () => {
    const body = 'Summary\n\nLinear-Priority: 1\nDepends-on: #4, #7\n\n## Tests\n\nok\n';
    const a = writeLanding(body, { gateSha: 'a'.repeat(40), queuedAt: '2026-11-06T00:00:00Z' });
    assert.match(a, /## Tests\n\nok/);
    assert.equal(writeLanding(a, { gateSha: 'a'.repeat(40), queuedAt: '2026-11-06T00:00:00Z' }), a, 'idempotent');
    const b = appendLanding(appendLanding(a, 'Bounced: 2026-11-06T01:00:00Z conflict'), `Gate: pass @ ${'b'.repeat(40)} (lander rebase)`);
    const l = parseLanding(b);
    assert.equal(l.gatedSha, 'b'.repeat(40));
    assert.equal(l.gates.length, 2);
    assert.equal(l.bounces.length, 1);
    assert.equal(l.priority, 1);
    assert.deepEqual(l.dependsOn, [4, 7]);
    const c = writeLanding(b, { gateSha: 'c'.repeat(40), queuedAt: '2026-11-07T00:00:00Z' });
    assert.equal(parseLanding(c).gates.length, 1, 're-queue resets the gate lines');
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

  test('busy lock: queues with labels and a Landing section', () => {
    const t = setup();
    const head = makePr(t, 1);
    setLock(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, 'QUEUED 1');
    const p = prOf(t, 1);
    assert.equal(p.state, 'OPEN');
    assert.deepEqual(p.labels, ['queued']);
    assert.match(p.body, new RegExp(`## Landing\\n\\n- Gate: pass @ ${head}\\n- Queued: `));
    assert.deepEqual(state(t).labels.sort(), ['landing', 'queue-blocked', 'queue-hold', 'queue-next', 'queue-waiting', 'queued']);
    assert.equal(lockExists(t), true, 'someone else\'s lock is left alone');
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

  test('hold: adds queue-hold and a Hold-By line in one edit; holder defaults to $T3CODE_THREAD_ID', () => {
    const t = setup();
    queuePr(t, 1);
    t.env.T3CODE_THREAD_ID = 'thread-from-env';
    const r = tool(t, LAND_PR, 'hold', '1', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out).holder, 'thread-from-env');
    const p = prOf(t, 1);
    assert.deepEqual(p.labels.sort(), ['queue-hold', 'queued']);
    assert.match(p.body, /^- Hold-By: thread-from-env \d{4}-\d\d-\d\dT\S+Z$/m);
    const edits = state(t).calls.filter((c) => c.cmd === 'pr edit');
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].add, ['queue-hold']);
    assert.equal(edits[0].body, true);
    const again = tool(t, LAND_PR, 'hold', '1', '--holder', 'x', '--repo', 'o/r');
    assert.equal(again.status, 2);
    assert.match(again.out, /^REFUSED queue-hold already set/);
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
    const r = tool(t, LAND_QUEUE, 'status', '--all', '--json');
    assert.equal(r.status, 1, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.length, 2);
    assert.equal(out[0].repo, 'o/r');
    assert.deepEqual(out[0].order.map((x) => x.pr), [1]);
    assert.match(out[1].error, /cannot tell the GitHub repo/);
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

  test('run: a PR retargeted mid-gate is aborted, then validated again against its new base', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    sh(t.bare, t.env, 'branch', 'other', 'main');
    t.env.LAND_TEST_GATE_ACTION = 'retarget:1';
    const rep = runQueue(t);
    assert.match(rep.aborted[0].reason, /base changed to other before the push/);
    assert.notEqual(sh(t.bare, t.env, 'rev-parse', 'refs/heads/other'), head);
    // The second round landed it on its new base, after a new rebase and gate.
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 2);
  });

  test('run: a replaced landing lock is never deleted, and losing it aborts the landing', () => {
    const t = setup();
    const head = queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    Object.assign(t.env, { LAND_TEST_GATE_ACTION: 'steal:1', LAND_TEST_GATE_SLEEP_MS: '1500', AGENT_LAND_TICK_MS: '200' });
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.aborted[0].reason, /landing lock was lost/);
    assert.match(rep.alerts.join('\n'), /lock was lost while landing #1; stopped/);
    assert.deepEqual(prOf(t, 1).labels, ['queued']);
    assert.equal(sh(t.bare, t.env, 'rev-parse', 'refs/heads/agent/LEE-1-change'), head, 'not pushed');
    assert.equal(lockSha(t), fs.readFileSync(`${t.env.LAND_TEST_GATE}.stolen`, 'utf8'), 'the other lander keeps its lock');
    assert.equal(state(t).calls.some((c) => c.cmd === 'pr merge'), false);
  });

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
    // Pushes to origin fail (the lease delete included); the GitHub API still answers.
    sh(t.work, t.env, 'remote', 'set-url', '--push', 'origin', path.join(t.tmp, 'no such remote.git'));
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.ok(rep.lockRetained?.sha);
    assert.match(rep.alerts.join('\n'), /landing lock could not be released.*git push --no-verify origin :refs\/heads\/agent-landing-lock/);
    assert.equal(lockExists(t), true);
    const t2 = setup();
    const head = makePr(t2, 2);
    sh(t2.work, t2.env, 'remote', 'set-url', '--push', 'origin', path.join(t2.tmp, 'no such remote.git'));
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
    const { spawn } = process.getBuiltinModule('node:child_process');
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

  test('run: a pushed rebased head whose gate line was not written is recognised next run (no bounce)', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    const s = state(t); s.failBodyEditMatching = '(lander rebase)'; saveState(t, s);
    const first = tool(t, LAND_QUEUE, 'run', '--repo', 'o/r', '--json');
    assert.equal(first.status, 1, 'the run reports the failed edit');
    assert.deepEqual(prOf(t, 1).labels, ['queued'], 'back in line, not blocked');
    assert.match(prOf(t, 1).body, /Gate: pending @ [0-9a-f]{40}/);
    const rep = runQueue(t);
    assert.deepEqual(rep.bounced, []);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(parseLanding(prOf(t, 1).body).bounces.length, 0, 'no fix attempt used');
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
    p.body = writeLanding('', { gateSha: head, queuedAt: '2026-11-06T01:00:00Z' });
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
    Object.assign(t.env, { LAND_TEST_GATE_HANG: '1', AGENT_LAND_CMD_TIMEOUT_MS: '2000', AGENT_LAND_STUCK_MS: '1500', AGENT_LAND_TEST_NO_KILL: '1' });
    try {
      const rep = runQueue(t);
      assert.match(rep.bounced[0].reason, /timed out after .* the landing lock is kept/);
      assert.ok(rep.lockRetained?.sha, 'the lock is reported as kept');
      assert.match(rep.alerts.join('\n'), /the landing lock is kept because .* may still run.*; stop that command's processes/);
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
    s.prs.push({ number: 1, title: 'f1', headRefName: 'agent/LEE-1-change', baseRefName: 'main', state: 'OPEN', labels: ['queued'], body: writeLanding('', { gateSha: head, queuedAt: '2026-11-06T01:00:00Z' }) });
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
      // Lock reads: #1 in the first full re-check before the merge; the change lands right after
      // it, so only the last read before the merge sees it.
      const s = state(t); s.mutateAfter = { kind: 'lockGet', n: 1, pr: 1, ...mutate }; saveState(t, s);
      const rep = runQueue(t);
      assert.equal(state(t).mutateAfter.seen >= 1, true);
      check(t, rep, mainBefore);
      assert.equal(lockExists(t), false);
    });
  }

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
