// node --test tests/lifecycle/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BIN, isWin, scratch } from './helpers.mjs';

const lib = (n) => import(pathToFileURL(path.join(BIN, 'lib', n)).href);
const proc = await lib('proc.mjs');
const op = await lib('op.mjs');
const repo = await lib('repo.mjs');
const ledger = await lib('ledger.mjs');
const procs = await lib('processes.mjs');

const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const tmp = () => { const s = scratch([]); cleanups.push(s.cleanup); return s; };

describe('proc', () => {
  test('splitArgv', () => {
    assert.deepEqual(proc.splitArgv('npm ci --no-audit'), ['npm', 'ci', '--no-audit']);
    assert.deepEqual(proc.splitArgv(`node -e "a \\"b\\" c" 'd e'`), ['node', '-e', 'a "b" c', 'd e']);
    assert.deepEqual(proc.splitArgv('echo $'), ['echo', '$']);
    for (const bad of ['a && b', 'a | b', 'a > f', 'a; b', 'echo $HOME', 'echo $(x)', '"open']) {
      assert.throws(() => proc.splitArgv(bad), undefined, bad);
    }
  });

  test('which and run pass awkward arguments through unchanged (incl. .cmd on Windows)', () => {
    const s = tmp();
    const script = path.join(s.dir, 'echo args.mjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const name = 'echoargs';
    if (isWin) fs.writeFileSync(path.join(s.bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
    else {
      fs.writeFileSync(path.join(s.bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(path.join(s.bin, name), 0o755);
    }
    const env = proc.withPath(process.env, s.bin);
    assert.ok(proc.which(name, env));
    const args = ['plain', 'with space', 'a&b|c', 'q"uote', '100%', '(paren)', 'caret^', 'tail\\', ''];
    const r = proc.run(name, args, { env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
    assert.equal(proc.run('definitely-not-installed-x', [], { env }).status, 127);
  });

  test('run feeds stdin only when input is given', () => {
    const r = proc.run(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(0,"utf8"))'], { input: 'piped' });
    assert.equal(r.stdout, 'piped');
  });
});

describe('op', () => {
  test('parseRegQuery', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    OP_SERVICE_ACCOUNT_TOKEN    REG_SZ    abc123\r\n\r\n';
    assert.equal(op.parseRegQuery(out), 'abc123');
    assert.equal(op.parseRegQuery('nothing'), null);
  });

  test('resolveOp: PATH first, then the WinGet folders on Windows', () => {
    const s = tmp();
    const local = path.join(s.home, 'AppData', 'Local');
    const env = { ...proc.withPath(process.env, s.bin), LOCALAPPDATA: local, USERPROFILE: s.home, HOME: s.home };
    assert.equal(op.resolveOp(env), null);
    if (isWin) {
      const pkg = path.join(local, 'Microsoft', 'WinGet', 'Packages', 'AgileBits.1Password.CLI_test');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'op.exe'), '');
      assert.equal(op.resolveOp(env), path.join(pkg, 'op.exe'));
    }
    const onPath = path.join(s.bin, isWin ? 'op.cmd' : 'op');
    fs.writeFileSync(onPath, isWin ? '@exit /b 0\r\n' : '#!/bin/sh\n');
    fs.chmodSync(onPath, 0o755);
    assert.equal(op.resolveOp(env), onPath);
  });

  test('opEnv / stripToken: test mode uses the process env only', () => {
    const env = { AGENT_ENV_NO_SECRETS: '1', OP_SERVICE_ACCOUNT_TOKEN: 't1', X: '1' };
    assert.equal(op.opEnv(env).OP_SERVICE_ACCOUNT_TOKEN, 't1');
    assert.equal('OP_SERVICE_ACCOUNT_TOKEN' in op.stripToken(env), false);
    assert.equal(op.readToken({ AGENT_ENV_NO_SECRETS: '1' }), null);
  });

  test('readTokenFile requires a private regular file', { skip: isWin }, () => {
    const s = tmp();
    const f = path.join(s.dir, 'token');
    fs.writeFileSync(f, 'tok\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.equal(op.readTokenFile(f), null);
    fs.chmodSync(f, 0o600);
    assert.equal(op.readTokenFile(f), 'tok');
    const link = path.join(s.dir, 'link');
    fs.symlinkSync(f, link);
    assert.equal(op.readTokenFile(link), null);
  });
});

describe('repo and ledger', () => {
  test('makeWtId sanitises and bounds the id', () => {
    assert.equal(repo.makeWtId('Demo', '/x/Agent LEE-1 Feature'), 'demo-agent-lee-1-feature');
    const long = repo.makeWtId('a-very-long-repository-name', '/x/agent-lee-12345-an-extremely-long-worktree-name');
    assert.ok(long.length <= 40);
    assert.match(long, /^[a-z0-9-]+$/);
    assert.notEqual(long, repo.makeWtId('a-very-long-repository-name', '/x/agent-lee-12345-an-extremely-long-worktree-other'));
  });

  test('loadConfig merges defaults and rejects other versions', () => {
    const s = tmp();
    assert.equal(repo.loadConfig(s.dir).vault, 'agent-repos');
    fs.mkdirSync(path.join(s.dir, '.agents'));
    fs.writeFileSync(path.join(s.dir, '.agents', 'repo.json'), JSON.stringify({ version: 1, env: { output: '.env.dev' }, gate: 'npm test' }));
    const c = repo.loadConfig(s.dir);
    assert.deepEqual([c.env.template, c.env.output, c.gate, c.found], ['.env.op', '.env.dev', ['npm test'], true]);
    fs.writeFileSync(path.join(s.dir, '.agents', 'repo.json'), JSON.stringify({ version: 2 }));
    assert.throws(() => repo.loadConfig(s.dir));
  });

  test('ledger updates are locked and atomic', () => {
    const s = tmp();
    const common = path.join(s.dir, 'common');
    for (let i = 0; i < 20; i++) ledger.updateLedger(common, 'w', (l) => ledger.addResource(l, 'dir', `/p${i % 5}`));
    const l = ledger.readLedger(common, 'w');
    assert.equal(l.resources.length, 5);
    assert.deepEqual(fs.readdirSync(ledger.ledgerDir(common)), ['w.json']);
  });

  test('mentionsPath does not match a sibling with a longer name', () => {
    const base = isWin ? 'C:\\x\\wt-1' : '/x/wt-1';
    assert.equal(procs.mentionsPath(`node ${base}${isWin ? '\\' : '/'}server.js`, base), true);
    assert.equal(procs.mentionsPath(`node ${base}0${isWin ? '\\' : '/'}server.js`, base), false);
  });
});
