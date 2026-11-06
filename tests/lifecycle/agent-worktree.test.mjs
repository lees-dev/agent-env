// node --test tests/lifecycle/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  DUMMY_TOKEN, ENGINE, engine, gitIn, isWin, ledgerOf, makeRepo, pr, scratch, write,
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

describe('units', () => {
  test('foreignRefs accepts only op://agent-repos/<repo>-...', () => {
    const ok = 'A=op://agent-repos/demo-api-dev/A\nB="op://agent-repos/demo-db-test/B"\n';
    assert.equal(foreignRefs(ok, 'demo'), 0);
    assert.equal(foreignRefs('A=op://other-vault/demo-api-dev/A\n', 'demo'), 1);
    assert.equal(foreignRefs('A=op://agent-repos/other-api-dev/A\n', 'demo'), 1);
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
        'scratch/.keep': '',
        '.agents/hooks.mjs': [
          "import fs from 'node:fs';",
          "export async function setup(ctx) {",
          "  ctx.track('neon-branch', 'br-' + ctx.wtId, 'neon');",
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
    assert.match(env, /AGENT_WT_ID=demo-wt-one/);
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
    assert.ok(l.resources.some((x) => x.kind === 'env-file'));
    const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.agents', 'state', 'repos.json'), 'utf8'));
    assert.equal(reg.repos.length, 1);
    // The gate gets the ports but never the token.
    const g = engine(s, ['gate'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(g.status, 0, g.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.wt, 'scratch', 'gate.json'), 'utf8')), { t: null });
    // A second setup keeps the port.
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
    assert.match(env, /AGENT_WT_ID=demo-wt-one/);
  });

  test('refuses .env.op references outside op://agent-repos/<repo>-', () => {
    const { s, repo } = fixture({ files: { '.env.op': 'A=op://agent-repos/demo-api-dev/A\nB=op://Private/bank/password\n' } });
    write(path.join(repo.wt, '.env.local'), 'A=stale\n');
    const r = engine(s, ['setup'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /SECRETS NOT INJECTED: \.env\.op has 1 reference outside op:\/\/agent-repos\/demo-/);
    assert.equal(s.calls('op').length, 0);
    assert.equal(fs.existsSync(path.join(repo.wt, '.env.local')), false);
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
});

describe('teardown', () => {
  function merged(s, repo, over = {}) {
    s.writeState((st) => {
      st.gh.prs = [pr({ headRefOid: repo.head, ...over })];
      st.docker.containers = containers(repo.wtId);
      st.docker.volumes = [{ id: 'v1', labels: { 'agent.wt': repo.wtId } }];
    });
  }

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

  test('gh failure: keep, exit 1', () => {
    const { s, repo } = fixture();
    s.writeState((st) => { st.gh.fail = true; });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /cannot read PR state/);
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

  test('closed (not merged): resources removed, remote branch kept', () => {
    const { s, repo } = fixture();
    merged(s, repo, { state: 'CLOSED' });
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
    assert.equal(s.readState().gh.deleted, undefined);
    assert.equal(s.readState().docker.containers.length, 1);
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

  for (const label of ['queued', 'landing', 'queue-blocked', 'queue-waiting']) {
    test(`PR labelled ${label}: keep`, () => {
      const { s, repo } = fixture();
      merged(s, repo, { state: 'CLOSED', labels: [{ name: label }] });
      const r = engine(s, ['teardown'], repo.wt);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, new RegExp(`land queue \\(${label}\\)`));
      assert.equal(s.readState().docker.containers.length, 2);
    });
  }

  test('squash merged: HEAD equals the PR head but is on no remote branch: eligible', () => {
    const { s, repo } = fixture({ push: false });
    merged(s, repo);
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 0, r.out);
  });

  test('extra unpublished commit: keep, exit 1', () => {
    const { s, repo } = fixture();
    merged(s, repo);
    write(path.join(repo.wt, 'more.txt'), 'more\n');
    gitIn(s, repo.wt, 'add', '-A');
    gitIn(s, repo.wt, 'commit', '-q', '-m', 'more');
    const r = engine(s, ['teardown'], repo.wt);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /1 commit not on any remote/);
  });

  test('extra commit named by a Gate: pass line (lander rebase) counts as pushed', () => {
    const { s, repo } = fixture();
    write(path.join(repo.wt, 'more.txt'), 'more\n');
    gitIn(s, repo.wt, 'add', '-A');
    gitIn(s, repo.wt, 'commit', '-q', '-m', 'more');
    const local = gitIn(s, repo.wt, 'rev-parse', 'HEAD');
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

  test('stops processes under the worktree, runs hooks.teardown, deletes tracked paths', async () => {
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
    const cache = path.join(s.dir, 'cache dir');
    fs.mkdirSync(cache);
    assert.equal(engine(s, ['track', 'dir', cache], repo.wt).status, 0);
    assert.equal(engine(s, ['track', 'neon-branch', 'b1', '--where', 'neon'], repo.wt).status, 0);
    const script = path.join(repo.wt, 'scratch', 'server.js');
    write(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 300));
    const exited = new Promise((r) => child.once('exit', () => r(true)));
    const r = engine(s, ['teardown'], repo.wt, { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /1 process stopped/);
    assert.equal(await Promise.race([exited, new Promise((res) => setTimeout(() => res(false), 5000))]), true);
    assert.equal(fs.existsSync(cache), false);
    const hook = JSON.parse(fs.readFileSync(path.join(s.dir, 'hook-teardown.json'), 'utf8'));
    assert.deepEqual(hook, { wtId: 'demo-wt-one', branch: 'agent/LEE-1-feature', gone: false, token: null });
    assert.equal(ledgerOf(repo).resources.some((x) => x.kind === 'neon-branch'), false);
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
    s.writeState((st) => { st.gh.prs = [pr({ headRefOid: repo.head })]; st.docker.containers = containers(repo.wtId); });
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
    // The merged branch has no worktree any more and is fully pushed: deleted.
    assert.equal(gitIn(s, repo.main, 'branch', '--list', repo.branch), '');
  });

  test('worktree gone but PR queued: kept', () => {
    const { s, repo } = fixture();
    assert.equal(engine(s, ['setup'], repo.wt).status, 0);
    s.writeState((st) => { st.gh.prs = [pr({ headRefOid: repo.head, state: 'CLOSED', labels: [{ name: 'queue-blocked' }] })]; st.docker.containers = containers(repo.wtId); });
    gitIn(s, repo.main, 'worktree', 'remove', '--force', repo.wt);
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /kept demo-wt-one: PR #7 is in the land queue/);
    assert.equal(s.readState().docker.containers.length, 2);
  });

  test('hand-made worktree outside the T3 root: removed when eligible; T3 worktrees left to T3', () => {
    const { s, repo } = fixture();
    // A second worktree inside the (fake) T3 root, also merged.
    const t3wt = path.join(s.home, '.t3', 'worktrees', 'demo', 'agent-t3');
    gitIn(s, repo.main, 'worktree', 'add', '-q', '-b', 'agent/LEE-3-t3', t3wt);
    s.writeState((st) => {
      st.gh.prs = [pr({ headRefOid: repo.head }), pr({ number: 9, headRefName: 'agent/LEE-3-t3', headRefOid: gitIn(s, t3wt, 'rev-parse', 'HEAD') })];
    });
    const r = engine(s, ['sweep'], repo.main);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /1 worktrees removed/);
    assert.equal(fs.existsSync(repo.wt), false);
    assert.ok(fs.existsSync(t3wt));
    assert.equal(gitIn(s, repo.main, 'branch', '--list', repo.branch), '');
  });

  test('sweep keeps open-PR, queued and unpushed worktrees and branches', () => {
    const { s, repo } = fixture();
    write(path.join(repo.wt, 'more.txt'), 'more\n');
    gitIn(s, repo.wt, 'add', '-A');
    gitIn(s, repo.wt, 'commit', '-q', '-m', 'more');
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
    assert.equal(engine(s, ['track', 'dir', path.join(s.dir, 'c')], repo.wt).status, 0);
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
    assert.equal(rows[0].wtId, 'demo-wt-one');
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
