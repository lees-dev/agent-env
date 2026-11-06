// Tests for home/dot_agents/bin/land-pr.mjs, land-queue.mjs and lib/land.mjs.
// Run: node --test tests/bin/
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

const GATE = `import fs from 'node:fs';
const f = process.env.LAND_TEST_GATE;
if (f) fs.appendFileSync(f + '.runs', 'x');
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
    ]).map((p) => p.number);
    assert.deepEqual(out, [5, 3, 4, 6, 2, 1]);
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
    const s = scrub(`DATABASE_URL=postgres://u:p@h/db API_TOKEN: abc123 sk-${'x'.repeat(24)} me@corp.example Bearer abcdefghijkl`);
    assert.doesNotMatch(s, /u:p@|abc123|xxxxxxxx|me@corp|abcdefghijkl/);
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
    assert.deepEqual(state(t).labels.sort(), ['landing', 'queue-blocked', 'queue-hold', 'queue-next', 'queued']);
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

  test('queue-hold (full stop): HELD, never merged or queued', () => {
    const t = setup();
    const head = makePr(t, 1, { labels: ['queue-hold'] });
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, 'HELD');
    assert.equal(prOf(t, 1).state, 'OPEN');
    assert.deepEqual(prOf(t, 1).labels, ['queue-hold']);
  });

  test('dry run makes no changes', () => {
    const t = setup();
    const head = makePr(t, 1);
    const r = tool(t, LAND_PR, '1', '--sha', head, '--repo', 'o/r', '--dry-run');
    assert.equal(r.out, 'WOULD-MERGE');
    assert.equal(state(t).calls.length, 0);
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

  test('run: a red wide sweep holds the rest of the queue', () => {
    const t = setup({ sweepEveryMerges: 1, wideSweep: 'node scripts/sweep.mjs' });
    queuePr(t, 1, { priority: 1 });
    queuePr(t, 2, { priority: 2 });
    t.env.LAND_TEST_SWEEP = 'fail';
    const rep = runQueue(t);
    assert.deepEqual(rep.merged.map((m) => m.pr), [1]);
    assert.equal(rep.sweep.ok, false);
    assert.match(rep.alerts[0], /wide sweep on main failed/);
    assert.deepEqual(rep.held, [2]);
    assert.ok(prOf(t, 2).labels.includes('queue-hold'));
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
