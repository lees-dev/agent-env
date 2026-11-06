// node --test "tests/lifecycle/*.test.mjs"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  DUMMY_TOKEN, ENGINE, engine, gitIn, installFake, isWin, ledgerOf, makeRepo, makeWtId, pr, scratch, write,
} from './helpers.mjs';

const { foreignRefs, gatedShas, writeFooter, allocatePorts, parseArgs } = await import(pathToFileURL(ENGINE).href);

const cleanups = [];
after(() => { for (const c of cleanups) c(); });
function fixture(opts) {
  const s = scratch();
  cleanups.push(s.cleanup);
  const repo = makeRepo(s, opts);
  return { s, repo };
}
const containers = (wtId) => [
  { id: 'c1', labels: { 'agent.wt': wtId } },
  { id: 'c2', labels: { 'agent.wt': 'other-wt' } },
];
/** A directory link: a junction on Windows, a symlink elsewhere. */
const dirLink = (target, link) => fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!pidAlive(pid)) return true; await sleep(100); }
  return !pidAlive(pid);
}
function merged(s, repo, over = {}) {
  s.writeState((st) => {
    st.gh.prs = [pr({ headRefOid: repo.head, ...over })];
    st.gh.remoteRefs = { [repo.branch]: repo.head };
    st.docker.containers = containers(repo.wtId);
    st.docker.volumes = [{ id: 'v1', labels: { 'agent.wt': repo.wtId } }];
  });
}
function commit(s, dir, file, text = 'x\n') {
  write(path.join(dir, file), text);
  gitIn(s, dir, 'add', '-A');
  gitIn(s, dir, 'commit', '-q', '-m', file);
  return gitIn(s, dir, 'rev-parse', 'HEAD');
}

describe('units', () => {
  test('foreignRefs accepts only op://agent-repos/<prefix>-...', () => {
    const ok = 'A=op://agent-repos/demo-api-dev/A\nB="op://agent-repos/demo-db-test/B"\n';
    assert.equal(foreignRefs(ok, 'demo'), 0);
    assert.equal(foreignRefs('A=op://other-vault/demo-api-dev/A\n', 'demo'), 1);
    assert.equal(foreignRefs('A=op://agent-repos/other-api-dev/A\n', 'demo'), 1);
    assert.equal(foreignRefs('A=OP://other-vault/demo-api-dev/A\nB=Op://Agent-Repos/Demo-api-dev/B\n', 'demo'), 1, 'case-insensitive');
    assert.equal(foreignRefs('A=op://agent-repos/demo-/A\nB=op://agent-repos/demoapi/B\n', 'demo'), 2);
  });
  test('gatedShas reads Gate lines', () => {
    assert.deepEqual(gatedShas('## Landing\nGate: pass @ abcdef1\nGate: pass @ ABCDEF0123456 (lander rebase)\n'), ['abcdef1', 'abcdef0123456']);
  });
  test('writeFooter replaces its own block and keeps the rest', () => {
    const s = scratch([]);
    cleanups.push(s.cleanup);
    const f = path.join(s.dir, '.env.local');
    fs.writeFileSync(f, 'A=1\n');
    writeFooter(f, { AGENT_WT_ID: 'x', PORT: 3001 });
    writeFooter(f, { AGENT_WT_ID: 'x', PORT: 3002 });
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /^A=1\n/);
    assert.equal(t.match(/BEGIN agent-worktree/g).length, 1);
    assert.match(t, /PORT=3002/);
    assert.doesNotMatch(t, /PORT=3001/);
  });
  test('allocatePorts is stable and avoids taken ports', async () => {
    const a = await allocatePorts({ PORT: 41000 }, 'demo-wt');
    const b = await allocatePorts({ PORT: 41000 }, 'demo-wt');
    assert.equal(a.PORT, b.PORT);
    assert.ok(a.PORT >= 41000 && a.PORT < 41900);
    const c = await allocatePorts({ PORT: 41000 }, 'demo-wt', {}, new Set([a.PORT]));
    assert.notEqual(c.PORT, a.PORT);
    assert.deepEqual(await allocatePorts({ PORT: 41000 }, 'x', { PORT: 41234 }), { PORT: 41234 });
  });
  test('a stored port that another ledger now holds is reallocated', async () => {
    const p = await allocatePorts({ P: 43000 }, 'w', { P: 43005 }, new Set([43005]));
    assert.notEqual(p.P, 43005);
    const keep = await allocatePorts({ P: 43000 }, 'w', { P: 43005 }, new Set());
    assert.equal(keep.P, 43005);
  });

  test('parseArgs', () => {
    const o = parseArgs(['track', 'neon-branch', 'b1', '--where', 'neon', '--dry-run']);
    assert.deepEqual([o._, o.where, o.dryRun], [['track', 'neon-branch', 'b1'], 'neon', true]);
    assert.throws(() => parseArgs(['--nope']));
  });
});

describe('setup', () => {
  test('main checkout: nothing to do', () => {
    const { s, repo } = fixture();
    const r = engine(s, ['setup'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /main checkout/);
    assert.equal(fs.existsSync(path.join(repo.commonDir, 'agent-resources')), false);
  });

  test('injects secrets, writes the footer, runs steps and hooks; token only reaches op', () => {
    const { s, repo } = fixture({
      config: {
        ports: { PORT: 42000 },
        setup: ['node -e "require(\'fs\').writeFileSync(\'scratch/setup.json\', JSON.stringify({t: process.env.OP_SERVICE_ACCOUNT_TOKEN || null, p: process.env.PORT}))"'],
        gate: ['node -e "require(\'fs\').writeFileSync(\'scratch/gate.json\', JSON.stringify({t: process.env.OP_SERVICE_ACCOUNT_TOKEN || null}))"'],
      },
      files: {
        '.env.op': 'API_KEY=op://agent-repos/demo-api-dev/API_KEY\nLITERAL=1\n',
        '.agents/hooks.mjs': [
          "import fs from 'node:fs';",
          "export async function setup(ctx) {",
          "  ctx.track('neon-branch', 'br-' + ctx.wtId, 'neon');",
          "  ctx.track('cache', 'scratch/cache');",
          "  const child = ctx.run(['node', '-e', 'process.stdout.write(String(process.env.OP_SERVICE_ACCOUNT_TOKEN || null))']);",
          "  fs.writeFileSync('scratch/hook.json', JSON.stringify({ inProcess: process.env.OP_SERVICE_ACCOUNT_TOKEN || null, child: child.stdout, ticket: ctx.ticket, ports: ctx.ports }));",
          "}",
        ].join('\n'),
      },
    });
    fs.mkdirSync(path.join(repo.wt, 'scratch'), { recursive: true });
    s.writeState((st) => { st.op.items.push({ id: 'i1', vault: 'agent-repos', title: 'demo-api-dev', fields: [{ id: 'API_KEY', label: 'API_KEY', value: 'dummy-api-value' }] }); });
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes(DUMMY_TOKEN) && !r.out.includes('dummy-api-value'));
    const env = fs.readFileSync(path.join(repo.wt, '.env.local'), 'utf8');
    assert.match(env, /API_KEY=dummy-api-value/);
    assert.match(env, new RegExp(`AGENT_WT_ID=${repo.wtId}`));
    const port = Number(env.match(/PORT=(\d+)/)[1]);
    assert.ok(port >= 42000 && port < 42900);
    const op = s.calls('op');
    assert.equal(op.length, 1);
    assert.equal(op[0].args[0], 'inject');
    assert.equal(op[0].hasToken, true);
    const setupOut = JSON.parse(fs.readFileSync(path.join(repo.wt, 'scratch', 'setup.json'), 'utf8'));
    assert.deepEqual(setupOut, { t: null, p: String(port) });
    const hook = JSON.parse(fs.readFileSync(path.join(repo.wt, 'scratch', 'hook.json'), 'utf8'));
    assert.deepEqual(hook, { inProcess: null, child: 'null', ticket: 'LEE-1', ports: { PORT: port } });
    const l = ledgerOf(repo);
    assert.equal(l.ports.PORT, port);
    assert.equal(l.branch, 'agent/LEE-1-feature');
    assert.ok(l.resources.some((x) => x.kind === 'neon-branch' && x.where === 'neon'));
    assert.ok(l.resources.some((x) => x.kind === 'cache' && x.id === path.join(repo.wt, 'scratch', 'cache')), 'relative tracked paths are stored absolute');
    assert.ok(l.resources.some((x) => x.kind === 'env-file'));
    const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.agents', 'state', 'repos.json'), 'utf8'));
    assert.equal(reg.repos.length, 1);
    const g = engine(s, ['gate'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(g.status, 0, g.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.wt, 'scratch', 'gate.json'), 'utf8')), { t: null });
    const again = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(again.status, 0, again.out);
    assert.equal(ledgerOf(repo).ports.PORT, port);
  });

  test('without op: warns loudly and leaves no stale secrets', () => {
    const { s, repo } = fixture({ config: { ports: { PORT: 43000 } }, files: { '.env.op': 'API_KEY=op://agent-repos/demo-api-dev/API_KEY\n' } });
    fs.rmSync(path.join(s.bin, isWin ? 'op.cmd' : 'op'));
    write(path.join(repo.wt, '.env.local'), 'API_KEY=stale-value\n');
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /SECRETS NOT INJECTED/);
    const env = fs.readFileSync(path.join(repo.wt, '.env.local'), 'utf8');
    assert.doesNotMatch(env, /stale-value/);
    assert.match(env, new RegExp(`AGENT_WT_ID=${repo.wtId}`));
  });

  test('refuses .env.op references outside op://agent-repos/<repo>-', () => {
    const { s, repo } = fixture({ files: { '.env.op': 'A=op://agent-repos/demo-api-dev/A\nB=op://other-vault/other-item/FIELD\n' } });
    write(path.join(repo.wt, '.env.local'), 'A=stale\n');
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /SECRETS NOT INJECTED: \.env\.op has 1 reference outside op:\/\/agent-repos\/demo-/);
    assert.equal(s.calls('op').length, 0);
    assert.equal(fs.existsSync(path.join(repo.wt, '.env.local')), false);
  });

  test('itemPrefix replaces the repo name in the reference check', () => {
    const { s, repo } = fixture({ config: { itemPrefix: 'dm' }, files: { '.env.op': 'A=op://agent-repos/dm-api-dev/A\n' } });
    s.writeState((st) => { st.op.items.push({ id: 'i1', vault: 'agent-repos', title: 'dm-api-dev', fields: [{ id: 'A', label: 'A', value: 'v' }] }); });
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /secrets injected/);
  });

  test('refuses an env output that is not git-ignored, tracked, or a link', () => {
    for (const kind of ['unignored', 'tracked', 'symlink']) {
      const files = { '.env.op': 'A=op://agent-repos/demo-api-dev/A\n' };
      const config = kind === 'unignored' ? { env: { output: '.env.dev' } } : {};
      if (kind === 'tracked') files['.env.tracked'] = 'X=1\n';
      const { s, repo } = fixture({ files, config: kind === 'tracked' ? { env: { output: '.env.tracked' } } : config });
      if (kind === 'symlink') {
        const target = path.join(s.dir, 'elsewhere.txt');
        fs.writeFileSync(target, 'keep\n');
        try { fs.symlinkSync(target, path.join(repo.wt, '.env.local'), 'file'); } catch (e) { if (e.code === 'EPERM') continue; throw e; }
      }
      const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
      assert.equal(r.status, 0, r.out);
      assert.match(r.stderr, kind === 'symlink' ? /is a symlink/ : kind === 'tracked' ? /is tracked by git/ : /is not git-ignored/, kind);
      assert.equal(s.calls('op').length, 0, kind);
      if (kind === 'tracked') assert.equal(fs.readFileSync(path.join(repo.wt, '.env.tracked'), 'utf8'), 'X=1\n');
      if (kind === 'symlink') assert.equal(fs.readFileSync(path.join(s.dir, 'elsewhere.txt'), 'utf8'), 'keep\n');
    }
  });

  test('refuses an env output under a linked folder and leaves the link target alone', () => {
    const { s, repo } = fixture({ files: { '.env.op': 'A=op://agent-repos/demo-api-dev/A\n' }, config: { env: { output: 'scratch/link/.env.local' } } });
    const elsewhere = path.join(s.dir, 'elsewhere');
    write(path.join(elsewhere, '.env.local'), 'keep\n');
    fs.mkdirSync(path.join(repo.wt, 'scratch'), { recursive: true });
    dirLink(elsewhere, path.join(repo.wt, 'scratch', 'link'));
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /has a linked folder in its path/);
    assert.equal(s.calls('op').length, 0);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.env.local'), 'utf8'), 'keep\n');
  });

  test('a refused env output the user created is left alone', () => {
    const { s, repo } = fixture({ config: { env: { output: '.env.dev' } } });
    write(path.join(repo.wt, '.env.dev'), 'MINE=1\n');
    const r = engine(s, ['setup'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /is not git-ignored/);
    assert.equal(fs.readFileSync(path.join(repo.wt, '.env.dev'), 'utf8'), 'MINE=1\n');
  });

  test('a failing setup step fails setup', () => {
    const { s, repo } = fixture({ config: { setup: ['node -e "process.exit(3)"'] } });
    const r = engine(s, ['setup'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /setup step failed \(exit 3\)/);
  });

  test('shell syntax in a setup step is rejected', () => {
    const { s, repo } = fixture({ config: { setup: ['npm ci && npm run build'] } });
    const r = engine(s, ['setup'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /shell syntax is not supported/);
  });

  test('two same-named worktrees get separate ids, ledgers and ports', () => {
    const { s, repo } = fixture({ config: { ports: { PORT: 44000 } } });
    const a = path.join(s.dir, 'a', 'wt');
    const b = path.join(s.dir, 'b', 'wt');
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-7-a', a);
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-8-b', b);
    const ida = makeWtId('demo', a);
    const idb = makeWtId('demo', b);
    assert.notEqual(ida, idb);
    assert.ok(ida.length <= 40 && idb.length <= 40);
    assert.equal(engine(s, ['setup'], a).status, 0);
    assert.equal(engine(s, ['setup'], b).status, 0);
    const la = ledgerOf(repo, ida);
    const lb = ledgerOf(repo, idb);
    assert.equal(la.branch, 'agent/LEE-7-a');
    assert.equal(lb.branch, 'agent/LEE-8-b');
    assert.notEqual(la.ports.PORT, lb.ports.PORT);
  });

  test('refuses a ledger that records another existing worktree', () => {
    const { s, repo } = fixture();
    const other = path.join(s.dir, 'other');
    fs.mkdirSync(other);
    write(path.join(repo.commonDir, 'agent-resources', `${repo.wtId}.json`), JSON.stringify({ worktreePath: other, resources: [], ports: {} }));
    for (const cmd of [['setup'], ['teardown'], ['track', 'dir', 'x']]) {
      const r = engine(s, cmd, repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /belongs to another worktree/);
    }
  });
});

describe('teardown', () => {
  test('open PR: nothing removed, exit 0', () => {
    const { s, repo } = fixture();
    write(path.join(repo.wt, '.env.local'), 'X=1\n');
    merged(s, repo, { state: 'OPEN' });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /PR #7 is open: nothing removed/);
    assert.ok(fs.existsSync(path.join(repo.wt, '.env.local')));
    assert.equal(s.calls('docker').length, 0);
    assert.equal(s.readState().gh.deleted, undefined);
  });

  test('no PR: nothing removed, exit 0', () => {
    const { s, repo } = fixture();
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /no PR for this branch: nothing removed/);
  });

  test('no PR or an open PR with uncommitted files: kept, exit 1', () => {
    for (const state of [null, 'OPEN']) {
      const { s, repo } = fixture();
      if (state) merged(s, repo, { state });
      write(path.join(repo.wt, 'notes.txt'), 'wip\n');
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /keep: .*1 changed or untracked file/);
      assert.equal(ledgerOf(repo).state, 'kept');
    }
  });

  test('an env file that cannot be deleted keeps the worktree', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    write(path.join(repo.wt, '.env.local', 'inner'), 'X=1\n');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /could not delete \.env\.local/);
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('gh failure: keep, exit 1', () => {
    const { s, repo } = fixture();
    s.writeState((st) => { st.gh.fail = true; });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /cannot read PR state/);
  });

  test('ghWrapper from repo.json is used for gh calls', () => {
    const fakeGh = path.resolve(path.dirname(ENGINE), '..', '..', '..', 'tests', 'lifecycle', 'fakes', 'fake.mjs');
    const { s, repo } = fixture({ config: { ghWrapper: `node "${fakeGh}" gh` } });
    fs.rmSync(path.join(s.bin, isWin ? 'gh.cmd' : 'gh'));
    merged(s, repo);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.ok(s.calls('gh').length >= 3);
  });

  test('merged but dirty: keep with counts, exit 1', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    write(path.join(repo.wt, 'notes.txt'), 'wip\n');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /keep: 1 changed or untracked file/);
    assert.equal(s.readState().docker.containers.length, 2);
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('merged and clean: labelled objects, env file and remote branch removed; second run idempotent', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    write(path.join(repo.wt, '.env.local'), 'X=1\n');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    const st = s.readState();
    assert.deepEqual(st.docker.containers.map((c) => c.id), ['c2']);
    assert.equal(st.docker.volumes.length, 0);
    assert.deepEqual(st.gh.deleted, ['repos/{owner}/{repo}/git/refs/heads/agent/LEE-1-feature']);
    assert.equal(fs.existsSync(path.join(repo.wt, '.env.local')), false);
    assert.ok(fs.existsSync(repo.wt), 'the worktree itself is never deleted');
    const l = ledgerOf(repo);
    assert.equal(l.state, 'torn-down');
    assert.equal(l.remoteBranchDeleted, true);
    const again = engine(s, ['teardown'], repo.wt);
    assert.equal(again.status, 0, again.out);
    assert.equal(s.readState().gh.deleted.length, 1);
    assert.equal(ledgerOf(repo).state, 'torn-down');
  });

  test('remote branch moved after the merge: not deleted', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    s.writeState((st) => { st.gh.remoteRefs[repo.branch] = 'f'.repeat(40); });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /remote branch moved/);
    assert.equal(s.readState().gh.deleted, undefined);
  });

  test('branch names are percent-encoded per segment in the API path', () => {
    const { s, repo } = fixture({ branch: 'agent/LEE-9-a#b' });
    merged(s, repo, { headRefName: 'agent/LEE-9-a#b' });
    s.writeState((st) => { st.gh.remoteRefs = { 'agent/LEE-9-a#b': repo.head }; });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(s.readState().gh.deleted, ['repos/{owner}/{repo}/git/refs/heads/agent/LEE-9-a%23b']);
  });

  test('a remote branch delete that fails (not "already gone") keeps the worktree', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    s.writeState((st) => { st.gh.deleteStatus = 'invalid'; });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /remote branch not deleted/);
    const l = ledgerOf(repo);
    assert.equal(l.state, 'kept');
    assert.equal(Boolean(l.remoteBranchDeleted), false);
  });

  test('an invalid remoteBranchDelete pattern keeps the worktree before anything is removed', () => {
    const { s, repo } = fixture({ config: { remoteBranchDelete: '(' } });
    merged(s, repo);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /remoteBranchDelete .* is not a valid pattern/);
    assert.equal(s.readState().docker.containers.length, 2);
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('a worktree port still in use keeps the worktree', async () => {
    const { s, repo } = fixture({
      config: { ports: { PORT: 41000 } },
      files: { '.agents/hooks.mjs': 'import fs from "node:fs";\nexport function teardown(ctx) { fs.writeFileSync(ctx.worktreePath + "/hook-ran.txt", "x"); }\n' },
    });
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    const port = ledgerOf(repo).ports.PORT;
    const srv = net.createServer();
    await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
    try {
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, new RegExp(`1 port of this worktree still in use \\(PORT ${port}\\)`));
      assert.ok(fs.existsSync(path.join(repo.wt, 'hook-ran.txt')), 'the teardown hook ran before the port check');
      assert.equal(ledgerOf(repo).state, 'kept');
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  });

  test('a server on IPv6 loopback also keeps the worktree', async () => {
    const { s, repo } = fixture({ config: { ports: { PORT: 42000 } } });
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    const port = ledgerOf(repo).ports.PORT;
    const srv = net.createServer();
    const ok = await new Promise((resolve) => { srv.once('error', () => resolve(false)); srv.listen(port, '::1', () => resolve(true)); });
    if (!ok) return; // no IPv6 on this machine
    try {
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /still in use/);
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  });

  test('a hook that exits 3, or exits 0 before it finishes, is a failure', () => {
    for (const code of [3, 0]) {
      const { s, repo } = fixture({ files: { '.agents/hooks.mjs': `export async function teardown() { process.exit(${code}); }\n` } });
      merged(s, repo);
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, code ? /hooks\.teardown failed \(exit 3\)/ : /hooks\.teardown exited before it finished/);
      assert.equal(ledgerOf(repo).state, 'kept');
    }
  });

  test('an unreadable ledger is never replaced', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const f = path.join(repo.commonDir, 'agent-resources', `${repo.wtId}.json`);
    write(f, '{ not json');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(f, 'utf8'), '{ not json');
    // A merged, pushed branch would normally go; an unreadable ledger may need it.
    gitIn(s, repo.main, 'branch', 'agent/LEE-7-done');
    s.writeState((st) => { st.gh.prs.push(pr({ number: 9, headRefName: 'agent/LEE-7-done', headRefOid: gitIn(s, repo.main, 'rev-parse', 'HEAD') })); });
    const sw = engine(s, ['sweep'], repo.main);
    assert.equal(sw.status, 1, sw.out);
    assert.match(sw.stdout, /not swept while a ledger is unreadable/);
    assert.notEqual(gitIn(s, repo.main, 'branch', '--list', 'agent/LEE-7-done'), '');
    assert.equal(fs.readFileSync(f, 'utf8'), '{ not json');
  });

  test('a failing cr-review --cleanup keeps the worktree', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const cr = path.join(s.bin, isWin ? 'cr-review.cmd' : 'cr-review');
    fs.writeFileSync(cr, isWin ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
    fs.chmodSync(cr, 0o755);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /cr-review --cleanup LEE-1 exited 1/);
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('a tracked env output with a staged change or staged deletion counts as dirty', () => {
    for (const change of ['modify', 'delete']) {
      const { s, repo } = fixture({ config: { env: { output: 'README.md' } } });
      merged(s, repo);
      if (change === 'modify') {
        write(path.join(repo.wt, 'README.md'), 'changed\n');
        gitIn(s, repo.wt, 'add', 'README.md');
      } else gitIn(s, repo.wt, 'rm', '-q', 'README.md');
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, `${change}: ${r.out}`);
      assert.match(r.stderr, /keep: 1 changed or untracked file/, change);
      assert.equal(s.readState().gh.deleted, undefined, change);
    }
  });

  test('closed (not merged): resources removed, remote branch kept', () => {
    const { s, repo } = fixture();
    merged(s, repo, { state: 'CLOSED' });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.equal(s.readState().gh.deleted, undefined);
    assert.equal(s.readState().docker.containers.length, 1);
  });

  test('docker present but failing: kept, exit 1', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    s.writeState((st) => { st.docker.fail = true; });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /docker containers list failed/);
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('open PR based on this branch (stacked): keep, exit 1', () => {
    const { s, repo } = fixture();
    s.writeState((st) => {
      st.gh.prs = [pr({ headRefOid: repo.head }), pr({ number: 8, state: 'OPEN', headRefName: 'agent/LEE-2-next', baseRefName: repo.branch })];
    });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /open PR #8 is based on this branch/);
  });

  for (const [state, label] of [['CLOSED', 'queued'], ['CLOSED', 'landing'], ['CLOSED', 'queue-blocked'], ['CLOSED', 'queue-waiting'], ['OPEN', 'queued'], ['MERGED', 'queue-hold']]) {
    test(`${state} PR labelled ${label}: keep, exit 1`, () => {
      const { s, repo } = fixture();
      merged(s, repo, { state, labels: [{ name: label }] });
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, new RegExp(`land queue \\(${label}\\)`));
      assert.equal(s.readState().docker.containers.length, 2);
    });
  }

  test('detached HEAD: kept when it has commits on no branch, remote or tag', () => {
    const { s, repo } = fixture();
    gitIn(s, repo.wt, 'checkout', '-q', '--detach');
    assert.equal(engine(s, ['teardown'], repo.wt).status, 0);
    commit(s, repo.wt, 'detached.txt');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /detached HEAD with 1 commit on no branch, remote or tag/);
  });

  test('detached HEAD keeps the branch the ledger recorded', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    gitIn(s, repo.wt, 'checkout', '-q', '--detach');
    assert.equal(engine(s, ['teardown'], repo.wt).status, 0);
    assert.equal(ledgerOf(repo).branch, repo.branch);
  });

  test('detached HEAD with uncommitted files: kept', () => {
    const { s, repo } = fixture();
    gitIn(s, repo.wt, 'checkout', '-q', '--detach');
    write(path.join(repo.wt, 'notes.txt'), 'wip\n');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /detached HEAD with 1 changed or untracked file/);
  });

  test('squash merged: HEAD equals the PR head but is on no remote branch: eligible', () => {
    const { s, repo } = fixture({ push: false });
    merged(s, repo);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
  });

  test('extra unpublished commit: keep, exit 1', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    commit(s, repo.wt, 'more.txt');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /1 commit not on any remote/);
  });

  test('extra commit named by a Gate: pass line (lander rebase) counts as pushed', () => {
    const { s, repo } = fixture();
    const local = commit(s, repo.wt, 'more.txt');
    merged(s, repo, { body: `## Landing\nGate: pass @ ${repo.head}\nGate: pass @ ${local.slice(0, 12)} (lander rebase)\n` });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
  });

  test('rewritten commit with the same patch as the PR head (range-diff) counts as pushed', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    gitIn(s, repo.wt, 'commit', '-q', '--amend', '--no-edit', '--date', '2026-01-02T03:04:05Z');
    assert.notEqual(gitIn(s, repo.wt, 'rev-parse', 'HEAD'), repo.head);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
  });

  test('rewritten commit with a different patch: keep', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    write(path.join(repo.wt, 'feature.txt'), 'changed\n');
    gitIn(s, repo.wt, 'commit', '-q', '-a', '--amend', '--no-edit');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /not on any remote/);
  });

  test('stops processes under the worktree and their children; leaves "wt one copy" alone; runs hooks.teardown', async () => {
    const { s, repo } = fixture({
      files: {
        '.agents/hooks.mjs': [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "export async function teardown(ctx) {",
          "  fs.writeFileSync(path.join(ctx.repoRoot, '..', 'hook-teardown.json'), JSON.stringify({ wtId: ctx.wtId, branch: ctx.branch, gone: ctx.worktreeGone, token: process.env.OP_SERVICE_ACCOUNT_TOKEN || null }));",
          "  ctx.untrack('neon-branch', 'b1');",
          "}",
        ].join('\n'),
      },
    });
    merged(s, repo);
    const cache = path.join(s.tmp, 'cache dir');
    fs.mkdirSync(cache);
    assert.equal(engine(s, ['track', 'dir', cache], repo.wt).status, 0);
    assert.equal(engine(s, ['track', 'neon-branch', 'b1', '--where', 'neon'], repo.wt).status, 0);
    // Parent inside the worktree starts a child with a relative command line.
    const scratchDir = path.join(repo.wt, 'scratch');
    write(path.join(scratchDir, 'child.js'), 'setInterval(() => {}, 1000);\n');
    write(path.join(scratchDir, 'parent.js'), [
      "const { spawn } = require('child_process');",
      "const c = spawn(process.execPath, ['child.js'], { cwd: __dirname, stdio: 'ignore' });",
      "require('fs').writeFileSync(require('path').join(__dirname, 'child.pid'), String(c.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const parent = spawn(process.execPath, [path.join(scratchDir, 'parent.js')], { stdio: 'ignore', windowsHide: true });
    const pidFile = path.join(scratchDir, 'child.pid');
    const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
    // Stop everything this test starts even when an assertion fails first.
    cleanups.unshift(() => {
      killQuietly(parent.pid);
      try { killQuietly(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* no pid file */ }
    });
    // A sibling folder whose name starts with the worktree's name.
    const copy = `${repo.wt} copy`;
    write(path.join(copy, 'server.js'), 'setInterval(() => {}, 1000);\n');
    const sibling = spawn(process.execPath, [path.join(copy, 'server.js')], { stdio: 'ignore', windowsHide: true });
    cleanups.unshift(() => killQuietly(sibling.pid));
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(100);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await sleep(200);
    const r = engine(s, ['teardown'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.ok(Number(r.stdout.match(/(\d+) process(es)? stopped/)[1]) >= 2, r.stdout);
    assert.equal(await waitDead(parent.pid), true, 'parent stopped');
    assert.equal(await waitDead(childPid), true, 'child with a relative command line stopped');
    assert.equal(pidAlive(sibling.pid), true, 'process in "wt one copy" untouched');
    assert.equal(fs.existsSync(cache), false);
    const hook = JSON.parse(fs.readFileSync(path.join(s.dir, 'hook-teardown.json'), 'utf8'));
    assert.deepEqual(hook, { wtId: repo.wtId, branch: 'agent/LEE-1-feature', gone: false, token: null });
    assert.equal(ledgerOf(repo).resources.some((x) => x.kind === 'neon-branch'), false);
  });

  test('a failed process listing keeps the worktree', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const r = engine(s, ['teardown'], repo.wt, { AGENT_WORKTREE_TEST_PROCLIST_FAIL: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /process list failed/);
    assert.equal(s.readState().docker.containers.length, 2);
  });

  test('tracked paths outside the allowlist or inside other checkouts are refused', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const sib = path.join(s.dir, 'sibling wt');
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-5-sib', sib);
    const ssh = path.join(s.home, '.ssh');
    write(path.join(ssh, 'id_test'), 'k\n');
    const link = path.join(s.tmp, 'link-to-main');
    dirLink(repo.main, link);
    const okDir = path.join(s.tmp, 'ok cache');
    fs.mkdirSync(okDir);
    const targets = [path.join(sib, 'README.md'), path.join(repo.main, 'README.md'), path.join(link, 'README.md'), ssh, repo.wt, okDir];
    for (const t of targets) assert.equal(engine(s, ['track', 'path', t], repo.wt).status, 0);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /inside another worktree/);
    assert.match(r.stderr, /inside the main checkout or git dir/);
    assert.match(r.stderr, /outside the worktree, the temp folder and ~\/\.cache/);
    assert.match(r.stderr, /is the worktree/);
    for (const t of targets.slice(0, 5)) assert.ok(fs.existsSync(t), `kept ${t}`);
    assert.equal(fs.existsSync(okDir), false, 'allowed path deleted');
    assert.equal(ledgerOf(repo).state, 'kept');
  });

  test('a tracked file inside a worktree nested in this one is refused', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const nested = path.join(repo.wt, 'scratch', 'nested');
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-6-nested', nested);
    const f = path.join(nested, 'README.md');
    assert.equal(engine(s, ['track', 'file', f], repo.wt).status, 0);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /inside another worktree/);
    assert.ok(fs.existsSync(f));
  });

  test('a second teardown while one runs exits 1; a dead holder is ignored', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const lock = path.join(repo.commonDir, 'agent-resources', `${repo.wtId}.teardown.lock`);
    write(lock, `${process.pid} held`);
    const busy = engine(s, ['teardown'], repo.wt);
    assert.equal(busy.status, 1, busy.out);
    assert.match(busy.stderr, /another teardown of this worktree is running/);
    write(lock, '2147480000 dead');
    const ok = engine(s, ['teardown'], repo.wt);
    assert.equal(ok.status, 0, ok.out);
  });

  test('dry run changes nothing', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    const r = engine(s, ['teardown', '--dry-run'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /would do/);
    assert.equal(s.readState().docker.containers.length, 2);
    assert.equal(ledgerOf(repo), null);
  });
});

describe('sweep, status, track, gate', () => {
  test('worktree gone: sweep finishes the teardown, then forgets the ledger', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep', '--quick'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /1 finished/);
    assert.deepEqual(s.readState().docker.containers.map((c) => c.id), ['c2']);
    assert.equal(s.readState().gh.deleted.length, 1);
    assert.equal(ledgerOf(repo).state, 'torn-down');
    const again = engine(s, ['sweep', '--quick'], repo.main);
    assert.equal(again.status, 0, again.out);
    assert.equal(ledgerOf(repo), null);
    assert.equal(gitIn(s, repo.main, 'branch', '--list', repo.branch), '');
  });

  test('a truncated PR index is re-queried per branch', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    s.writeState((st) => { st.gh.prs.unshift(pr({ number: 99, headRefName: 'agent/LEE-99-other', state: 'OPEN' })); });
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep', '--quick'], repo.main, { AGENT_WORKTREE_PR_LIMIT: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /1 finished/);
    assert.ok(s.calls('gh').some((c) => c.args.includes('--head')), 're-queried with --head');
  });

  test('gone worktree with an unpushed branch keeps its resources', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    commit(s, repo.wt, 'unpushed.txt');
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep', '--quick'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /kept .*1 commit not on any remote/);
    assert.equal(s.readState().docker.containers.length, 2);
    assert.equal(ledgerOf(repo).state, 'active');
  });

  test('gone worktree with no PR keeps its resources', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    s.writeState((st) => { st.docker.containers = containers(repo.wtId); });
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep', '--quick'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /no PR for this branch/);
    assert.equal(s.readState().docker.containers.length, 2);
  });

  test('a live worktree recorded through a link (or \\\\?\\ prefix) is not treated as gone', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    const alias = path.join(s.tmp, 'alias');
    dirLink(s.dir, alias);
    const variants = [path.join(alias, path.basename(repo.wt))];
    if (isWin) variants.push(`\\\\?\\${repo.wt}`);
    for (const v of variants) {
      const f = path.join(repo.commonDir, 'agent-resources', `${repo.wtId}.json`);
      const l = JSON.parse(fs.readFileSync(f, 'utf8'));
      l.worktreePath = v;
      fs.writeFileSync(f, JSON.stringify(l));
      const r = engine(s, ['sweep', '--quick'], repo.main);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /0 finished/);
      assert.equal(s.readState().docker.containers.length, 2, v);
    }
  });

  test('a failing git worktree list deletes nothing', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    installFake(s.bin, 'git');
    s.writeState((st) => { st.git = { failWorktreeList: true }; });
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /git worktree list failed/);
    assert.equal(s.readState().docker.containers.length, 2);
    assert.ok(fs.existsSync(repo.wt));
    assert.ok(ledgerOf(repo));
  });

  test('worktree gone but PR queued: kept', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo, { state: 'CLOSED', labels: [{ name: 'queue-blocked' }] });
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`kept ${repo.wtId}: PR #7 is in the land queue`));
    assert.equal(s.readState().docker.containers.length, 2);
  });

  test('setup after teardown reactivates the ledger and resets remoteBranchDeleted', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    assert.equal(engine(s, ['teardown'], repo.wt).status, 0);
    assert.equal(ledgerOf(repo).remoteBranchDeleted, true);
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    const l = ledgerOf(repo);
    assert.equal(l.state, 'active');
    assert.equal(l.remoteBranchDeleted, false);
  });

  test('a torn-down ledger\'s tracked Docker ids are removed before it is forgotten', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    assert.equal(engine(s, ['teardown'], repo.wt).status, 0);
    assert.equal(engine(s, ['track', 'docker-container', 'late1'], repo.wt).status, 0);
    s.writeState((st) => { st.docker.containers.push({ id: 'late1', labels: {} }); });
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep', '--quick'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(s.readState().docker.containers.map((c) => c.id), ['c2']);
    assert.equal(ledgerOf(repo), null);
  });

  test('torn-down ledger is forgotten only after its Docker cleanup succeeds', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    assert.equal(engine(s, ['teardown'], repo.wt).status, 0);
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    s.writeState((st) => { st.docker.fail = true; });
    assert.equal(engine(s, ['sweep', '--quick'], repo.main).status, 1);
    assert.ok(ledgerOf(repo));
    s.writeState((st) => { st.docker.fail = false; });
    assert.equal(engine(s, ['sweep', '--quick'], repo.main).status, 0);
    assert.equal(ledgerOf(repo), null);
  });

  test('a failed gone-ledger cleanup keeps the branch, so a later sweep can finish it', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    merged(s, repo);
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    s.writeState((st) => { st.docker.fail = true; });
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /an unfinished ledger still needs it/);
    assert.notEqual(gitIn(s, repo.main, 'branch', '--list', repo.branch), '');
    assert.equal(ledgerOf(repo).state, 'kept');
    s.writeState((st) => { st.docker.fail = false; });
    const again = engine(s, ['sweep'], repo.main);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /1 finished/);
    assert.deepEqual(s.readState().docker.containers.map((c) => c.id), ['c2']);
    assert.equal(ledgerOf(repo).state, 'torn-down');
  });

  test('sweep --json stays valid when hooks.sweep prints', () => {
    const { s, repo } = fixture({ files: { '.agents/hooks.mjs': 'export function sweep() { console.log("hook says hi"); }\n' } });
    const r = engine(s, ['sweep', '--quick', '--json'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).repos.length, 1);
    assert.match(r.stderr, /hook says hi/);
  });

  test('an invalid repo.json fails the sweep without leaving its lock', () => {
    const { s, repo } = fixture();
    write(path.join(repo.main, '.agents', 'repo.json'), JSON.stringify({ version: 2 }));
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 1, r.out);
    assert.equal(fs.existsSync(path.join(repo.commonDir, 'agent-resources', 'sweep.lock')), false);
  });

  test('hand-made worktree outside the T3 root: removed when eligible; T3 worktrees (also via a link) left to T3', () => {
    const { s, repo } = fixture();
    const realT3 = path.join(s.dir, 't3 real');
    const t3wt = path.join(realT3, 'demo', 'agent-t3');
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-3-t3', t3wt);
    const t3alias = path.join(s.tmp, 't3 alias');
    dirLink(realT3, t3alias);
    s.writeState((st) => {
      st.gh.prs = [pr({ headRefOid: repo.head }), pr({ number: 9, headRefName: 'agent/LEE-3-t3', headRefOid: gitIn(s, t3wt, 'rev-parse', 'HEAD') })];
    });
    const r = engine(s, ['sweep'], repo.main, { AGENT_WORKTREE_T3_ROOT: t3alias });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /1 worktrees removed/);
    assert.equal(fs.existsSync(repo.wt), false);
    assert.ok(fs.existsSync(t3wt));
    assert.equal(gitIn(s, repo.main, 'branch', '--list', repo.branch), '');
  });

  test('sweep keeps open-PR, queued and unpushed worktrees and branches', () => {
    const { s, repo } = fixture();
    commit(s, repo.wt, 'more.txt');
    gitIn(s, repo.main, 'branch', 'agent/LEE-4-open');
    gitIn(s, repo.main, 'branch', 'agent/LEE-5-queued');
    s.writeState((st) => {
      st.gh.prs = [
        pr({ headRefOid: repo.head }),
        pr({ number: 10, state: 'OPEN', headRefName: 'agent/LEE-4-open' }),
        pr({ number: 11, state: 'CLOSED', headRefName: 'agent/LEE-5-queued', labels: [{ name: 'queued' }] }),
      ];
    });
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(repo.wt));
    assert.match(r.stdout, /kept wt one: 1 commit not on any remote/);
    assert.match(r.stdout, /kept branch agent\/LEE-4-open: PR #10 is open/);
    assert.match(r.stdout, /kept branch agent\/LEE-5-queued: PR #11 is in the land queue/);
    assert.notEqual(gitIn(s, repo.main, 'branch', '--list', 'agent/LEE-4-open'), '');
  });

  test('a running sweep makes a second one skip the repo', () => {
    const { s, repo } = fixture();
    write(path.join(repo.commonDir, 'agent-resources', 'sweep.lock'), `${process.pid} held`);
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /skipped \(another sweep of this repo is running\)/);
  });

  test('sweep runs hooks.sweep once per repo with the ledgers, without the token', () => {
    const { s, repo } = fixture({
      files: {
        '.agents/hooks.mjs': [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "export async function sweep(ctx) {",
          "  fs.appendFileSync(path.join(ctx.repoRoot, '..', 'hook-sweep.jsonl'), JSON.stringify({ repo: ctx.repo, n: ctx.ledgers.length, dry: ctx.dryRun, token: process.env.OP_SERVICE_ACCOUNT_TOKEN || null }) + '\\n');",
          "}",
        ].join('\n'),
      },
    });
    assert.equal(engine(s, ['track', 'dir', 'c'], repo.wt).status, 0);
    const r = engine(s, ['sweep', '--quick'], repo.main, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    const lines = fs.readFileSync(path.join(s.dir, 'hook-sweep.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ repo: 'demo', n: 1, dry: false, token: null }]);
  });

  test('status lists ledgers; untrack forgets a resource', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['track', 'neon-branch', 'b1', '--where', 'neon'], repo.wt).status, 0);
    const st = engine(s, ['status', '--json'], repo.main);
    assert.equal(st.status, 0, st.out);
    const rows = JSON.parse(st.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wtId, repo.wtId);
    assert.equal(rows[0].resources, 1);
    assert.equal(engine(s, ['untrack', 'neon-branch', 'b1'], repo.wt).status, 0);
    assert.equal(ledgerOf(repo).resources.length, 0);
    assert.equal(engine(s, ['track', 'x', 'y'], repo.main).status, 2);
  });

  test('gate returns the failing exit code; no gate is a config error', () => {
    const { s, repo } = fixture({ config: { gate: ['node -e "process.exit(0)"', 'node -e "process.exit(5)"'] } });
    assert.equal(engine(s, ['gate'], repo.wt).status, 5);
    assert.equal(engine(s, ['gate', '--affected'], repo.wt).status, 2);
  });
});
