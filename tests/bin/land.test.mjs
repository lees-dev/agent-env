// Tests for home/dot_agents/bin/land-pr.mjs, land-queue.mjs and lib/land.mjs.
// Run: node --test "tests/**/*.test.mjs"
// Git is real (local bare "origin" plus a clone); gh is tests/bin/fake-gh.mjs on PATH, backed by
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
  resolveCommand, scrub, splitArgv, writeLanding,
} from '../../home/dot_agents/bin/lib/land.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../home/dot_agents/bin');
const LAND_PR = path.join(BIN, 'land-pr.mjs');
const LAND_QUEUE = path.join(BIN, 'land-queue.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

function pathKey(env) { return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'; }

function sh(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// The gate: counts its runs, fails when the control file says so or when it can see the
// 1Password token, and can change the fake GitHub mid-landing (LAND_TEST_GATE_ACTION).
const GATE = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const f = process.env.LAND_TEST_GATE;
if (f) fs.appendFileSync(f + '.runs', 'x');
if (process.env.OP_SERVICE_ACCOUNT_TOKEN) { console.log('token leaked into the gate'); process.exit(1); }
const [act, n] = (process.env.LAND_TEST_GATE_ACTION || '').split(':');
if (act) {
  const sf = process.env.FAKE_GH_STATE;
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const pr = s.prs.find((p) => p.number === Number(n));
  if (act === 'hold') pr.labels.push('queue-hold');
  if (act === 'pause') s.variables = { ...(s.variables || {}), AGENT_LANDING_PAUSED: '1' };
  if (act === 'move') {
    const g = (...a) => spawnSync('git', ['-C', process.env.FAKE_GH_BARE, ...a], { encoding: 'utf8' }).stdout.trim();
    const ref = 'refs/heads/' + pr.headRefName;
    const c = g('commit-tree', g('rev-parse', ref + '^{tree}'), '-p', g('rev-parse', ref), '-m', 'moved');
    g('update-ref', ref, c);
  }
  fs.writeFileSync(sf, JSON.stringify(s, null, 2));
}
process.exit(f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('fail') ? 1 : 0);
`;
const SWEEP = `process.exit(process.env.LAND_TEST_SWEEP === 'fail' ? 1 : 0);\n`;

function setup(repoJson = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land test '));
  temps.push(tmp);
  const bare = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'my repo');
  const fakebin = path.join(tmp, 'fake bin');
  fs.mkdirSync(fakebin);
  fs.copyFileSync(path.join(HERE, 'fake-gh.mjs'), path.join(fakebin, 'gh.mjs'));
  const stateFile = path.join(tmp, 'gh state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ prs: [], labels: [], comments: [], calls: [] }));
  const gitcfg = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitcfg, '');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('OP_')) delete env[k];
  env.OP_SERVICE_ACCOUNT_TOKEN = 'dummy-test-value';
  const pk = pathKey(env);
  env[pk] = `${fakebin}${path.delimiter}${env[pk] || ''}`;
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    FAKE_GH_STATE: stateFile, FAKE_GH_BARE: bare, AGENT_LAND_STATE_DIR: path.join(tmp, 'state'), AGENT_LAND_POLL_MS: '1',
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
  return { tmp, bare, work, env, stateFile };
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
  const r = spawnSync(process.execPath, [script, ...args], { cwd: t.work, env: t.env, encoding: 'utf8', shell: false });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

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

  test('resolveCommand finds .mjs shims in a directory with spaces', () => {
    const t = setup();
    const env = t.env;
    const hit = resolveCommand('gh', env);
    assert.ok(hit && hit.endsWith('gh.mjs'), hit);
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

  test('hold: holder defaults to <hostname>:<parent pid> without T3', () => {
    const t = setup();
    queuePr(t, 1);
    delete t.env.T3CODE_THREAD_ID;
    const r = tool(t, LAND_PR, 'hold', '1', '--repo', 'o/r', '--json');
    assert.equal(r.status, 0, r.err);
    assert.match(JSON.parse(r.out).holder, /^\S+:\d+$/);
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

  test('run: a red affected gate is retried once, then bounced with a scrubbed tail', () => {
    const t = setup();
    queuePr(t, 1);
    advanceMain(t, 'other.txt', 'x\n');
    fs.writeFileSync(t.env.LAND_TEST_GATE, 'fail');
    const rep = runQueue(t);
    assert.equal(rep.merged.length, 0);
    assert.match(rep.bounced[0].reason, /affected gate failed/);
    assert.equal(fs.readFileSync(`${t.env.LAND_TEST_GATE}.runs`, 'utf8').length, 2);
    assert.equal(prOf(t, 1).state, 'OPEN');
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
      assert.match(rep.bounced[0].reason, /head changed while landing.*before the push/);
      assert.deepEqual(prOf(t, 1).labels, ['queue-blocked']);
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
