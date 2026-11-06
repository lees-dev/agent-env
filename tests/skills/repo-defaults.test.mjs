// Tests for home/dot_agents/skills/exact_repo-defaults/scripts/apply.mjs on temp git repos.
// Run: node --test "tests/skills/*.test.mjs"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '../../home/dot_agents/skills/exact_repo-defaults');
const APPLY = path.join(SKILL, 'scripts', 'apply.mjs');
const BLOCK = fs.readFileSync(path.join(SKILL, 'assets', 'agents-block.md'), 'utf8').trimEnd();
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

// The real git binary (Git for Windows: the cmd\ launcher), for the forwarding shim.
function realGit() {
  const r = process.platform === 'win32'
    ? spawnSync('where.exe', ['git'], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return process.platform === 'win32' ? lines.find((l) => /\\cmd\\git\.exe$/i.test(l)) || lines.find((l) => /\.exe$/i.test(l)) : lines[0];
}
const GIT = realGit();

function env(tmp) {
  const gitcfg = path.join(tmp, 'gitconfig');
  if (!fs.existsSync(gitcfg)) fs.writeFileSync(gitcfg, '');
  return {
    ...process.env, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function git(cwd, e, ...args) {
  const r = spawnSync('git', args, { cwd, env: e, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A clone of a bare origin (so origin/HEAD exists), with the given files committed.
function repo(files = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo defaults '));
  temps.push(tmp);
  const e = env(tmp);
  const bare = path.join(tmp, 'Sample-App.git');
  const work = path.join(tmp, 'sample app');
  git(tmp, e, 'init', '--quiet', '--bare', '-b', 'main', bare);
  git(tmp, e, 'clone', '--quiet', bare, work);
  for (const [f, c] of Object.entries({ 'README.md': '# sample\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.writeFileSync(path.join(work, f), c);
  }
  git(work, e, 'add', '-A');
  git(work, e, 'commit', '--quiet', '-m', 'initial');
  git(work, e, 'push', '--quiet', 'origin', 'HEAD:main');
  git(work, e, 'remote', 'set-head', 'origin', '--auto');
  return { work, e };
}

function run(r, ...args) {
  const p = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--offline', ...args], { env: r.e, encoding: 'utf8', shell: false });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(p.stdout); } catch { json = null; } }
  return { status: p.status, out: p.stdout, err: p.stderr, json };
}

const read = (r, f) => fs.readFileSync(path.join(r.work, f), 'utf8');
function snapshot(r) {
  const out = {};
  for (const f of ['AGENTS.md', 'CLAUDE.md', 't3.json', '.agents/repo.json', '.gitignore', 'docs/agents/repo.md']) {
    const p = path.join(r.work, f);
    out[f] = fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
  }
  return out;
}

describe('repo-defaults apply.mjs', () => {
  test('fresh npm repo: check fails, apply creates everything, check passes, apply is idempotent', () => {
    const r = repo({
      'package.json': JSON.stringify({ scripts: { gate: 'npm run lint && npm test', lint: 'x' }, dependencies: { next: '15.0.0' } }),
      'package-lock.json': '{}',
    });
    const before = run(r, '--check');
    assert.equal(before.status, 1);
    assert.match(before.out, /DRIFT AGENTS\.md block/);
    const inspect = run(r, '--inspect');
    assert.equal(inspect.status, 0);
    assert.equal(fs.existsSync(path.join(r.work, 'AGENTS.md')), false, 'inspect writes nothing');

    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 0, a.out + a.err);
    assert.equal(a.json.drift, 0);
    assert.equal(a.json.actions.length, 6);
    assert.ok(read(r, 'AGENTS.md').startsWith(BLOCK));
    assert.equal(read(r, 'CLAUDE.md'), '@AGENTS.md\n');
    const t3 = JSON.parse(read(r, 't3.json'));
    assert.equal(t3.defaultThreadEnvMode, 'worktree');
    assert.equal(t3.scripts[0].runOnWorktreeCreate, true);
    assert.equal(t3.scripts[0].async, false);
    assert.equal(t3.scripts[1].runOnSettle, true);
    const rj = JSON.parse(read(r, '.agents/repo.json'));
    assert.equal(rj.version, 1);
    assert.equal(rj.repo, 'sample-app');
    assert.equal(rj.itemPrefix, 'sample-app');
    assert.equal(rj.base, 'main');
    assert.equal(rj.vault, 'agent-repos');
    assert.deepEqual(rj.setup, ['npm ci --no-audit --no-fund']);
    assert.deepEqual(rj.gate, ['npm run gate']);
    assert.deepEqual(rj.ports, { PORT: 3000 });
    assert.match(read(r, '.gitignore'), /^\.env\.local$/m);
    assert.match(read(r, '.gitignore'), /^\.env\.local\.pre-op$/m);
    assert.match(read(r, 'docs/agents/repo.md'), /TODO\(repo-defaults\)/);

    assert.equal(run(r, '--check').status, 0);
    const snap = snapshot(r);
    const again = run(r, '--apply', '--json');
    assert.equal(again.status, 0);
    assert.deepEqual(again.json.actions, []);
    assert.deepEqual(snapshot(r), snap);
  });

  test('repo-owned text is kept: block goes on top, CLAUDE.md gets the import prepended', () => {
    const owned = '# Sample\n\nRepo rule: run `make proto` first.\n';
    const r = repo({ 'AGENTS.md': owned, 'CLAUDE.md': 'Claude-only note.\n' });
    assert.equal(run(r, '--apply').status, 0);
    assert.equal(read(r, 'AGENTS.md'), `${BLOCK}\n\n${owned}`);
    assert.equal(read(r, 'CLAUDE.md'), '@AGENTS.md\n\nClaude-only note.\n');
  });

  test('an outdated block is refreshed in place; text around it is untouched; CRLF kept', () => {
    const old = '<!-- BEGIN agent-standard v0 (old) -->\r\nold text\r\n<!-- END agent-standard -->';
    const r = repo({ 'AGENTS.md': `# Title\r\n\r\n${old}\r\n\r\nBelow.\r\n` });
    const c = run(r, '--check');
    assert.equal(c.status, 1);
    assert.match(c.out, /DRIFT AGENTS\.md block: v0/);
    assert.equal(run(r, '--apply').status, 0);
    const text = read(r, 'AGENTS.md');
    assert.equal(text, `# Title\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}\r\n\r\nBelow.\r\n`);
  });

  test('t3.json: other scripts are kept but made manual; engine scripts go first', () => {
    const r = repo({
      't3.json': JSON.stringify({ defaultThreadEnvMode: 'local', worktreeSubmodules: 'none', scripts: [
        { name: 'Install', command: 'npm ci', runOnWorktreeCreate: true },
        { name: 'Dev', command: 'npm run dev' },
      ] }),
    });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 0);
    assert.match(a.json.actions.join('\n'), /1 other automatic script\(s\) made manual/);
    const t3 = JSON.parse(read(r, 't3.json'));
    assert.equal(t3.defaultThreadEnvMode, 'worktree');
    assert.equal(t3.worktreeSubmodules, 'none');
    assert.deepEqual(t3.scripts.map((s) => s.name), ['Agent setup', 'Agent teardown', 'Install', 'Dev']);
    assert.equal(t3.scripts[2].runOnWorktreeCreate, false);
  });

  test('existing .agents/repo.json: values kept, missing keys added; TODOs are warnings only', () => {
    const r = repo({
      '.agents/repo.json': JSON.stringify({ version: 1, repo: 'x', base: 'develop', vault: 'agent-repos', gate: ['make gate'] }),
      'pnpm-lock.yaml': '',
      'package.json': '{"scripts":{}}',
    });
    assert.equal(run(r, '--apply').status, 0);
    const rj = JSON.parse(read(r, '.agents/repo.json'));
    assert.equal(rj.base, 'develop');
    assert.deepEqual(rj.gate, ['make gate']);
    assert.deepEqual(rj.setup, ['pnpm install --frozen-lockfile']);
    assert.match(rj.affectedGate[0], /TODO\(repo-defaults\)/);
    const c = run(r, '--check');
    assert.equal(c.status, 0);
    assert.match(c.out, /WARN {2}TODO markers/);
  });

  test('a repo.json naming another vault is invalid and left alone', () => {
    const r = repo({ '.agents/repo.json': JSON.stringify({ version: 1, vault: 'other' }) });
    const a = run(r, '--apply');
    assert.equal(a.status, 1);
    assert.match(a.out, /vault is not agent-repos/);
    assert.equal(JSON.parse(read(r, '.agents/repo.json')).vault, 'other');
  });

  test('gitignore: a broader pattern already covers the lines', () => {
    const r = repo({ '.gitignore': 'node_modules/\n.env*\n' });
    assert.equal(run(r, '--apply').status, 0);
    assert.equal(read(r, '.gitignore'), 'node_modules/\n.env*\n');
  });

  test('inspect lists PR-gating workflows (not release ones) and env files by key count', () => {
    const r = repo({
      '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n',
      '.github/workflows/queue.yml': 'on: [merge_group, pull_request_target]\njobs: {}\n',
      '.github/workflows/release.yml': 'on:\n  push:\n    tags: ["v*"]\njobs:\n  x:\n    steps:\n      - run: echo pull_request\n',
      '.env.example': 'A=1\nB=2\n# comment\n',
    });
    fs.writeFileSync(path.join(r.work, '.env.local'), 'SECRET=value\n');
    const i = run(r, '--inspect', '--json');
    assert.deepEqual(i.json.gatingWorkflows, [
      { file: '.github/workflows/ci.yml', triggers: ['pull_request'] },
      { file: '.github/workflows/queue.yml', triggers: ['pull_request_target', 'merge_group'] },
    ]);
    const files = Object.fromEntries(i.json.env.files.map((f) => [f.file, f]));
    assert.equal(files['.env.example'].keys, 2);
    assert.equal(files['.env.example'].tracked, true);
    assert.equal(files['.env.example'].role, 'template');
    assert.equal(files['.env.local'].tracked, false);
    assert.equal(files['.env.local'].role, 'generated');
    assert.doesNotMatch(JSON.stringify(i.json), /value/, 'no env values in the output');
  });

  test('env files: only real sources are suggested for import; templates and .env.local are not', () => {
    const r = repo({ '.env.example': 'A=1\n' });
    fs.writeFileSync(path.join(r.work, '.env.local'), 'A=1\n');
    fs.writeFileSync(path.join(r.work, '.env.production'), 'A=1\n');
    const out = run(r, '--inspect').out;
    assert.match(out, /INFO {2}\.env\.production: 1 keys; migrate with agent-secret import/);
    assert.doesNotMatch(out, /\.env\.example[^\n]*migrate/);
    assert.doesNotMatch(out, /\.env\.local[^\n]*migrate/);
  });

  test('a dangling .env link is listed, not followed, and does not stop the report', (t) => {
    const r = repo();
    try { fs.symlinkSync(path.join(r.work, 'nowhere'), path.join(r.work, '.env.dev'), 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    const i = run(r, '--inspect', '--json');
    assert.equal(i.status, 0, i.err);
    const f = i.json.env.files.find((x) => x.file === '.env.dev');
    assert.equal(f.dangling, true);
  });

  test('an outdated block: only its span changes; blank lines elsewhere are kept', () => {
    const old = '<!-- BEGIN agent-standard v0 (old) -->\nold\n<!-- END agent-standard -->';
    const text = `# T\n\n\n\nIntro.\n\n${old}\n\n\n\nBelow.\n`;
    const r = repo({ 'AGENTS.md': text });
    assert.equal(run(r, '--apply').status, 0);
    assert.equal(read(r, 'AGENTS.md'), text.replace(old, BLOCK));
  });

  test('two managed blocks are reported for a manual fix and left alone', () => {
    const text = `${BLOCK}\n\nmiddle\n\n${BLOCK.replace('v1', 'v0')}\n`;
    const r = repo({ 'AGENTS.md': text });
    const a = run(r, '--apply');
    assert.equal(a.status, 1);
    assert.match(a.out, /DRIFT AGENTS\.md block: 2 managed blocks/);
    assert.equal(read(r, 'AGENTS.md'), text);
  });

  test('CLAUDE.md that is the same file as AGENTS.md (a hard link) is ok and untouched', () => {
    const r = repo({ 'AGENTS.md': `${BLOCK}\n` });
    fs.linkSync(path.join(r.work, 'AGENTS.md'), path.join(r.work, 'CLAUDE.md'));
    const c = run(r, '--inspect', '--json');
    assert.equal(c.json.items.find((i) => i.name === 'CLAUDE.md').status, 'ok');
    run(r, '--apply');
    assert.equal(read(r, 'AGENTS.md').startsWith('@AGENTS.md'), false);
  });

  test('t3.json: an exact canonical copy is dropped; a custom engine script is kept and reported', () => {
    const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'assets', 't3.json'), 'utf8'));
    const custom = { name: 'Setup plus seed', command: `${want.scripts[0].command} && npm run seed`, runOnWorktreeCreate: true };
    const r = repo({ 't3.json': JSON.stringify({ defaultThreadEnvMode: 'worktree', scripts: [custom, { ...want.scripts[1], name: 'Old teardown' }] }) });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 0, a.out);
    assert.match(a.json.actions.join('\n'), /1 custom script\(s\) that call agent-worktree kept/);
    const t3 = JSON.parse(read(r, 't3.json'));
    assert.deepEqual(t3.scripts.map((s) => s.name), ['Agent setup', 'Agent teardown', 'Setup plus seed']);
    assert.equal(t3.scripts[2].runOnWorktreeCreate, false);
  });

  test('JSON null in t3.json or repo.json is invalid; nothing is changed', () => {
    const r = repo({ 't3.json': 'null', '.agents/repo.json': 'null' });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    const st = Object.fromEntries(a.json.items.map((i) => [i.name, i.status]));
    assert.equal(st['t3.json'], 'invalid');
    assert.equal(st['.agents/repo.json'], 'invalid');
    assert.equal(read(r, 't3.json'), 'null');
    assert.equal(read(r, '.agents/repo.json'), 'null');
  });

  test('gitignore: lines covered only by a global excludes file are still drift', () => {
    const r = repo({ '.gitignore': 'node_modules/\n' });
    const global = path.join(path.dirname(r.work), 'global-ignore');
    fs.writeFileSync(global, '.env.local\n.env.local.pre-op\n');
    fs.writeFileSync(r.e.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${global.replace(/\\/g, '/')}\n`);
    const c = run(r, '--check');
    assert.equal(c.status, 1);
    assert.match(c.out, /DRIFT \.gitignore: not ignored: \.env\.local, \.env\.local\.pre-op/);
    assert.equal(run(r, '--apply').status, 0);
    assert.match(read(r, '.gitignore'), /^\.env\.local$/m);
  });

  test('an existing file that cannot be read is invalid and never overwritten', () => {
    const r = repo();
    fs.mkdirSync(path.join(r.work, 't3.json'));
    fs.mkdirSync(path.join(r.work, 'CLAUDE.md'));
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1, a.err);
    const st = Object.fromEntries(a.json.items.map((i) => [i.name, i]));
    assert.equal(st['t3.json'].status, 'invalid');
    assert.match(st['t3.json'].detail, /cannot be read/);
    assert.equal(st['CLAUDE.md'].status, 'invalid');
    assert.ok(fs.statSync(path.join(r.work, 't3.json')).isDirectory());
    assert.equal(st['AGENTS.md block'].status, 'ok', 'the other items still apply');
  });

  test('a write-only AGENTS.md (no read permission) is invalid and left as it was', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX permissions as a normal user'); return; }
    const r = repo({ 'AGENTS.md': 'Owned rules.\n' });
    const p = path.join(r.work, 'AGENTS.md');
    fs.chmodSync(p, 0o200);
    try {
      const a = run(r, '--apply', '--json');
      assert.equal(a.status, 1);
      assert.equal(a.json.items.find((i) => i.name === 'AGENTS.md block').status, 'invalid');
    } finally {
      fs.chmodSync(p, 0o644);
    }
    assert.equal(fs.readFileSync(p, 'utf8'), 'Owned rules.\n');
  });

  test('a fix that fails is reported with the fixes that were done; the rest still run', () => {
    const r = repo({ 'docs/agents': 'a file where the docs/agents folder should be\n' });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1, a.err);
    assert.ok(a.json, 'the report is still printed');
    assert.ok(a.json.actions.some((x) => /AGENTS\.md/.test(x)), 'earlier fixes are reported');
    assert.ok(a.json.actions.some((x) => /t3\.json/.test(x)), 'later fixes still ran');
    assert.deepEqual(a.json.failed.map((f) => f.name), ['docs/agents/repo.md']);
    assert.ok(read(r, 'AGENTS.md').startsWith(BLOCK));
    assert.equal(read(r, 'docs/agents'), 'a file where the docs/agents folder should be\n');
  });

  test('an existing file is rewritten atomically; a link keeps pointing at its target', (t) => {
    const old = '<!-- BEGIN agent-standard v0 -->\nold\n<!-- END agent-standard -->\n\nOwned.\n';
    const r = repo({ 'docs/RULES.md': old });
    try { fs.symlinkSync(path.join('docs', 'RULES.md'), path.join(r.work, 'AGENTS.md'), 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    assert.equal(run(r, '--apply').status, 0);
    assert.ok(fs.lstatSync(path.join(r.work, 'AGENTS.md')).isSymbolicLink(), 'still a link');
    assert.equal(read(r, 'docs/RULES.md'), `${BLOCK}\n\nOwned.\n`);
    assert.deepEqual(fs.readdirSync(path.join(r.work, 'docs')).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  });

  test('apply.mjs runs when started through a linked skill folder (junction or symlink)', () => {
    const r = repo();
    const link = path.join(path.dirname(r.work), 'linked skill');
    fs.symlinkSync(SKILL, link, process.platform === 'win32' ? 'junction' : 'dir');
    const p = spawnSync(process.execPath, [path.join(link, 'scripts', 'apply.mjs'), '--repo', r.work, '--check'], { env: r.e, encoding: 'utf8', shell: false });
    assert.equal(p.status, 1, 'drift found: main() ran');
    assert.match(p.stdout, /repo-defaults: drift/);
  });

  test('an untracked .env.op that a broad rule would ignore is reported; a tracked one is not', () => {
    const r = repo({ '.gitignore': '.env*\n' });
    const i = run(r, '--inspect', '--json');
    assert.equal(i.json.env.envOpIgnored, true);
    assert.match(run(r, '--inspect').out, /WARN {2}\.env\.op would be ignored/);
    assert.equal(read(r, '.gitignore'), '.env*\n', 'the repo .gitignore is not changed');
    fs.writeFileSync(path.join(r.work, '.env.op'), 'A=op://agent-repos/sample-app-x-dev/A\n');
    git(r.work, r.e, 'add', '-f', '.env.op');
    git(r.work, r.e, 'commit', '--quiet', '-m', 'env.op');
    assert.equal(run(r, '--inspect', '--json').json.env.envOpIgnored, false);
  });

  test('git and gh children never see OP_SERVICE_ACCOUNT_TOKEN', () => {
    const r = repo();
    git(r.work, r.e, 'remote', 'set-url', 'origin', 'https://github.com/o/sample-app.git');
    const bin = path.join(path.dirname(r.work), 'fake bin');
    const log = path.join(path.dirname(r.work), 'children.log');
    fs.mkdirSync(bin);
    const rec = path.join(bin, 'rec.mjs');
    fs.writeFileSync(rec, [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const [tool, ...args] = process.argv.slice(2);',
      "fs.appendFileSync(process.env.REC_LOG, `${tool} ${process.env.OP_SERVICE_ACCOUNT_TOKEN ? 'LEAK' : 'clean'}\\n`);",
      "if (tool === 'gh') { process.stdout.write('[]'); process.exit(0); }",
      "const g = spawnSync(process.env.REC_REAL_GIT, args, { stdio: 'inherit' });",
      'process.exit(g.status ?? 1);',
    ].join('\n'));
    for (const tool of ['git', 'gh']) {
      if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@"${process.execPath}" "${rec}" ${tool} %*\r\n`);
      else { fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${rec}" ${tool} "$@"\n`); fs.chmodSync(path.join(bin, tool), 0o755); }
    }
    const pk = Object.keys(r.e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const e = { ...r.e, [pk]: `${bin}${path.delimiter}${r.e[pk]}`, OP_SERVICE_ACCOUNT_TOKEN: 'dummy-test-value', REC_LOG: log, REC_REAL_GIT: GIT };
    const p = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--inspect', '--json'], { env: e, encoding: 'utf8', shell: false });
    assert.equal(p.status, 0, p.stderr);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(lines.some((l) => l.startsWith('git ')), 'git ran through the shim');
    assert.ok(lines.some((l) => l.startsWith('gh ')), 'gh ran through the shim');
    assert.deepEqual(lines.filter((l) => l.endsWith('LEAK')), []);
  });

  test('BEGIN without END is reported and never touched', () => {
    const text = '<!-- BEGIN agent-standard v1 -->\nhalf\n';
    const r = repo({ 'AGENTS.md': text });
    assert.equal(run(r, '--apply').status, 1);
    assert.equal(read(r, 'AGENTS.md'), text);
  });
});
