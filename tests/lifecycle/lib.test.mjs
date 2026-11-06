// node --test tests/lifecycle/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BIN, isWin, run, scratch, write } from './helpers.mjs';

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

  test('no export hands out the token; stripToken removes it; test mode uses the process env only', () => {
    for (const name of ['readToken', 'opEnv', 'readTokenFile', 'lookupToken']) assert.equal(op[name], undefined, name);
    const env = { AGENT_ENV_NO_SECRETS: '1', OP_SERVICE_ACCOUNT_TOKEN: 't1', X: '1' };
    assert.equal(op.opStatus(env).hasToken, true);
    assert.equal('OP_SERVICE_ACCOUNT_TOKEN' in op.stripToken(env), false);
    assert.equal(op.opStatus({ AGENT_ENV_NO_SECRETS: '1' }).hasToken, false);
  });

  test('the Unix token file must be a private regular file', { skip: isWin }, () => {
    const s = tmp();
    const dir = path.join(s.home, '.config', 'op');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'agent-env-token');
    const env = { HOME: s.home, PATH: process.env.PATH };
    fs.writeFileSync(f, 'tok\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.equal(op.opStatus(env).hasToken, false);
    fs.chmodSync(f, 0o600);
    assert.equal(op.opStatus(env).hasToken, true);
    fs.renameSync(f, path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), f);
    assert.equal(op.opStatus(env).hasToken, false);
  });
});

describe('processes', () => {
  const root = isWin ? 'C:\\project' : '/project';
  const sep = isWin ? '\\' : '/';
  const wt = `${root}${sep}wt`;
  const node = isWin ? '"C:\\Program Files\\nodejs\\node.exe"' : '/usr/bin/node';
  const proc1 = (pid, ppid, cmd, extra = {}) => ({
    pid, ppid, name: 'node', exe: '', cmd, cwd: '', start: String(1000 + pid),
    args: isWin ? procs.splitWindowsArgs(cmd) : cmd.split(' '), ...extra,
  });

  test('splitWindowsArgs follows CommandLineToArgvW', () => {
    assert.deepEqual(procs.splitWindowsArgs('"C:\\a b\\n.exe" "C:\\x y\\s.js" plain a\\\\"b c" d\\"e'), ['C:\\a b\\n.exe', 'C:\\x y\\s.js', 'plain', 'a\\b c', 'd"e']);
  });

  test('"wt copy" does not match "wt"; quoted paths with spaces and --flag=path do', () => {
    const list = [
      proc1(10, 1, `${node} "${root}${sep}wt copy${sep}server.js"`),
      proc1(11, 1, `${node} "${wt}${sep}dir with space${sep}server.js"`),
      proc1(12, 1, `${node} --require=${wt}${sep}hook.js app.js`),
      proc1(13, 1, `${node} ${root}${sep}wt2${sep}x.js`),
    ];
    if (!isWin) {
      list[0].args = ['/usr/bin/node', '/project/wt copy/server.js'];
      list[1].args = ['/usr/bin/node', '/project/wt/dir with space/server.js'];
    }
    assert.deepEqual(procs.processesUnder(wt, list).map((p) => p.pid).sort(), [11, 12]);
  });

  test('descendants of a match are included; the lifecycle tools and protected IDEs are not', () => {
    const list = [
      proc1(20, 1, `${node} ${wt}${sep}parent.js`),
      proc1(21, 20, `${node} child.js`),
      proc1(22, 21, `${node} grandchild.js`),
      proc1(23, 1, `${node} ${wt}${sep}x.js agent-worktree.mjs sweep`),
      proc1(24, 1, `idea64 ${wt}`, { name: 'idea64.exe', exe: isWin ? 'C:\\JetBrains\\idea64.exe' : '/opt/jetbrains/idea64' }),
    ];
    list[3].cmd = `${node} ${root}${sep}bin${sep}agent-worktree.mjs teardown --repo ${wt}`;
    list[3].args = isWin ? procs.splitWindowsArgs(list[3].cmd) : list[3].cmd.split(' ');
    assert.deepEqual(procs.processesUnder(wt, list).map((p) => p.pid).sort(), [20, 21, 22]);
  });

  test('a worktree folder named like a protected tool protects nothing inside it', () => {
    const tb = `${root}${sep}toolbox`;
    const exe = `${tb}${sep}bin${sep}server${isWin ? '.exe' : ''}`;
    const list = [
      proc1(70, 1, `${exe} --port 1`, { name: `server${isWin ? '.exe' : ''}`, exe }),
      proc1(71, 1, `idea64 ${tb}`, { name: 'idea64.exe', exe: isWin ? 'C:\\JetBrains\\idea64.exe' : '/opt/jetbrains/idea64' }),
    ];
    assert.deepEqual(procs.processesUnder(tb, list).map((p) => p.pid), [70]);
  });

  test('a "child" that started before its parent (reused parent pid) is not a descendant', () => {
    const list = [
      proc1(50, 1, `${node} ${wt}${sep}server.js`, { start: '5000' }),
      proc1(60, 50, `${node} unrelated.js`, { start: '4000' }),
      proc1(61, 50, `${node} child.js`, { start: '6000' }),
      proc1(62, 50, `${node} unknown.js`, { start: '' }),
    ];
    assert.deepEqual(procs.processesUnder(wt, list).map((p) => p.pid).sort(), [50, 61]);
  });

  test('a path split at its spaces matches only where the joined path really is', () => {
    const s = tmp();
    const dir = path.join(s.dir, 'wt');
    write(path.join(dir, 'b.js'), '');
    write(path.join(s.dir, 'wt copy', 'a.js'), '');
    const mk = (cmd) => (isWin ? { cmd, args: procs.splitWindowsArgs(cmd) } : { cmd, psOnly: true });
    assert.equal(procs.argsUnder(mk(`node ${path.join(s.dir, 'wt copy', 'a.js')}`), [dir]), false);
    assert.equal(procs.argsUnder(mk(`node ${path.join(s.dir, 'wt copy', 'removed.js')}`), [dir]), false, 'script gone, folder still there');
    if (isWin) {
      // Quoted arguments are complete: "<dir>" followed by copy\removed.js is the worktree itself.
      assert.equal(procs.argsUnder(mk(`node "${dir}" copy\\removed.js`), [dir]), true);
      assert.equal(procs.argsUnder(mk(`node "${path.join(s.dir, 'wt copy', 'a.js')}"`), [dir]), false);
    }
    assert.equal(procs.argsUnder(mk(`node ${path.join(dir, 'b.js')}`), [dir]), true);
  });

  test('ps output: a path must start a word and end at a separator', { skip: isWin }, () => {
    const ps = (cmd) => ({ cmd, psOnly: true });
    assert.equal(procs.argsUnder(ps('node /foreign/project/wt/server.js'), ['/project/wt']), false);
    assert.equal(procs.argsUnder(ps('node /var/tmp/wt/server.js'), ['/tmp/wt']), false);
    assert.equal(procs.argsUnder(ps('make -C /tmp/wt all'), ['/tmp/wt']), true);
    assert.equal(procs.argsUnder(ps('node --require=/tmp/wt/x.js app.js'), ['/tmp/wt']), true);
  });

  test('the ps listing fails when lsof cannot give working directories', () => {
    const psOut = { status: 0, stdout: '  1     0 Thu Nov  6 10:00:00 2026 /sbin/init\n', stderr: '' };
    assert.equal(procs.listPs({}, (cmd) => (cmd === 'ps' ? psOut : { status: 127, stdout: '', stderr: '', error: new Error('ENOENT') })), null);
    let psEnv;
    const comm = { status: 0, stdout: '  1 /Applications/IntelliJ IDEA.app/Contents/MacOS/idea\n', stderr: '' };
    const lsof = { status: 0, stdout: 'p1\nn/\n', stderr: '' };
    const runner = (main) => (cmd, args, o) => {
      if (cmd !== 'ps') return lsof;
      psEnv = o.env;
      return args.includes('pid=,comm=') ? comm : main;
    };
    const ok = procs.listPs({}, runner(psOut));
    assert.equal(ok.length, 1);
    assert.equal(ok[0].cwd, '/');
    assert.equal(psEnv.LC_ALL, 'C');
    assert.equal(ok[0].name, 'idea', 'the name comes from comm, even with spaces in the path');
    assert.equal(ok[0].exe, '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea');
    const odd = { status: 0, stdout: `${psOut.stdout}  2     1 jeu. 6 nov. 10:00:00 2026 /bin/x\n`, stderr: '' };
    assert.equal(procs.listPs({}, runner(odd)), null, 'an unreadable line makes the listing unknown');
  });

  test('stopProcesses re-checks a pid before SIGKILL', { skip: isWin }, async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    try {
      const entry = { pid: child.pid, start: 'a', cmd: 'c' };
      let calls = 0;
      const lister = () => (++calls === 1 ? [entry] : [{ ...entry, start: 'b' }]);
      procs.stopProcesses([entry], process.env, 300, lister);
      assert.equal(calls, 2);
      assert.doesNotThrow(() => process.kill(child.pid, 0), 'a reused pid is not killed');
    } finally { child.kill('SIGKILL'); }
  });
});

describe('entry points', () => {
  test('both scripts run when started through a linked folder', () => {
    const s = scratch();
    cleanups.push(s.cleanup);
    const linked = path.join(s.dir, 'linked bin');
    fs.symlinkSync(BIN, linked, isWin ? 'junction' : 'dir');
    const ref = run(path.join(linked, 'agent-secret.mjs'), ['ref', 'demo-api-dev', 'API_KEY'], s.dir, s.env);
    assert.equal(ref.status, 0, ref.out);
    assert.match(ref.stdout, /op:\/\/agent-repos\/demo-api-dev\/API_KEY/);
    const st = run(path.join(linked, 'agent-worktree.mjs'), ['status'], s.dir, s.env);
    assert.equal(st.status, 0, st.out);
    assert.match(st.stdout, /no ledgers/);
  });
});

describe('repo and ledger', () => {
  test('makeWtId: <repo>-<basename>-<path hash>, sanitised, at most 40 characters', () => {
    assert.match(repo.makeWtId('Demo', '/x/Agent LEE-1 Feature'), /^demo-agent-lee-1-feature-[0-9a-f]{6}$/);
    assert.notEqual(repo.makeWtId('demo', '/a/wt'), repo.makeWtId('demo', '/b/wt'));
    assert.equal(repo.makeWtId('demo', '/a/wt'), repo.makeWtId('demo', '/a/wt/'));
    const long = repo.makeWtId('a-very-long-repository-name', '/x/agent-lee-12345-an-extremely-long-worktree-name');
    assert.ok(long.length <= 40);
    assert.match(long, /^[a-z0-9-]+$/);
  });

  test('canonical resolves links and the \\\\?\\ prefix', () => {
    const s = tmp();
    const real = path.join(s.dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(s.dir, 'link');
    fs.symlinkSync(real, link, isWin ? 'junction' : 'dir');
    assert.equal(repo.canonKey(path.join(link, 'not-yet', 'f')), repo.canonKey(path.join(real, 'not-yet', 'f')));
    if (isWin) assert.equal(repo.canonKey(`\\\\?\\${real}`), repo.canonKey(real));
  });

  test('tryLock: owner token, busy while the holder lives, broken when it is dead', () => {
    const s = tmp();
    const lock = path.join(s.dir, 'x.lock');
    const release = ledger.tryLock(lock);
    assert.ok(release);
    assert.equal(ledger.tryLock(lock), null);
    fs.writeFileSync(lock, `${process.pid} someone-else`);
    release();
    assert.ok(fs.existsSync(lock), 'release never removes a lock it does not own');
    fs.writeFileSync(lock, '2147480000 dead');
    const again = ledger.tryLock(lock);
    assert.ok(again);
    again();
    assert.equal(fs.existsSync(lock), false);
  });

  test('tryLock: a stale lock is broken only under the recovery lock; very old locks are stale', () => {
    const s = tmp();
    const lock = path.join(s.dir, 'y.lock');
    fs.writeFileSync(lock, '2147480000 dead');
    fs.writeFileSync(`${lock}.recover`, `${process.pid} recovering`);
    assert.equal(ledger.tryLock(lock), null, 'another live process is recovering');
    assert.equal(fs.readFileSync(lock, 'utf8'), '2147480000 dead');
    fs.writeFileSync(`${lock}.recover`, '2147480001 crashed');
    assert.equal(ledger.tryLock(lock), null, 'a recovery file is never reclaimed automatically');
    assert.ok(fs.existsSync(`${lock}.recover`));
    fs.unlinkSync(`${lock}.recover`);
    const got = ledger.tryLock(lock);
    assert.ok(got, 'with no recovery in progress the stale lock is broken');
    got();
    assert.equal(fs.existsSync(`${lock}.recover`), false);
    fs.writeFileSync(lock, `${process.pid} long-ago`);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const ttl = ledger.tryLock(lock);
    assert.ok(ttl, 'a lock older than the TTL is stale even if its pid is in use');
    ttl();
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
});
