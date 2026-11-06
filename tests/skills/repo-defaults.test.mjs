// Tests for home/dot_agents/skills/exact_repo-defaults/scripts/apply.mjs on temp git repos.
// Run: node --test "tests/skills/*.test.mjs"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // No inherited GIT_* (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE from an outer git, such as a
  // hook): the fixture's git must only ever touch the temp repo (the lifecycle helpers do the same).
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return {
    ...base, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1',
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

  test('a stale block in AGENTS.md hard-linked as CLAUDE.md: refreshed in place, both names keep one inode', () => {
    const old = '<!-- BEGIN agent-standard v0 -->\nold\n<!-- END agent-standard -->\n\nOwned.\n';
    const r = repo({ 'AGENTS.md': old });
    fs.linkSync(path.join(r.work, 'AGENTS.md'), path.join(r.work, 'CLAUDE.md'));
    const ino = fs.statSync(path.join(r.work, 'AGENTS.md')).ino;
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 0, a.out);
    assert.equal(a.json.drift, 0);
    assert.equal(fs.statSync(path.join(r.work, 'AGENTS.md')).ino, ino, 'same inode');
    assert.equal(fs.statSync(path.join(r.work, 'CLAUDE.md')).ino, ino, 'still hard-linked');
    assert.equal(read(r, 'AGENTS.md'), `${BLOCK}\n\nOwned.\n`);
    assert.equal(read(r, 'CLAUDE.md'), `${BLOCK}\n\nOwned.\n`);
    assert.equal(run(r, '--check').status, 0);
  });

  test('a chain of links (AGENTS.md -> rules-link -> docs/RULES.md): the final file changes, both links stay', (t) => {
    const old = '<!-- BEGIN agent-standard v0 -->\nold\n<!-- END agent-standard -->\n\nOwned.\n';
    const r = repo({ 'docs/RULES.md': old });
    try {
      fs.symlinkSync(path.join('docs', 'RULES.md'), path.join(r.work, 'rules-link'), 'file');
      fs.symlinkSync('rules-link', path.join(r.work, 'AGENTS.md'), 'file');
    } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    assert.equal(run(r, '--apply').status, 0);
    assert.ok(fs.lstatSync(path.join(r.work, 'AGENTS.md')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(r.work, 'rules-link')).isSymbolicLink(), 'the middle link is still a link');
    assert.equal(read(r, 'docs/RULES.md'), `${BLOCK}\n\nOwned.\n`);
  });

  test('links that lead outside the repo (a file, or a folder on the way) are invalid; nothing outside changes', (t) => {
    const r = repo();
    const outside = path.join(path.dirname(r.work), 'outside.md');
    const outDir = path.join(path.dirname(r.work), 'outdir');
    fs.writeFileSync(outside, 'not the repo\n');
    fs.mkdirSync(outDir);
    try {
      fs.symlinkSync(path.join('..', 'outside.md'), path.join(r.work, 'AGENTS.md'), 'file');
      fs.symlinkSync(path.join('..', 'outdir'), path.join(r.work, 'docs'), 'dir');
    } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    const st = Object.fromEntries(a.json.items.map((i) => [i.name, i]));
    assert.equal(st['AGENTS.md block'].status, 'invalid');
    assert.match(st['AGENTS.md block'].detail, /outside the repo/);
    assert.equal(st['docs/agents/repo.md'].status, 'invalid');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'not the repo\n');
    assert.deepEqual(fs.readdirSync(outDir), [], 'nothing created outside');
  });

  test('reports never read through a link outside the repo (TODO markers in an outside docs folder)', () => {
    const r = repo();
    const outDir = path.join(path.dirname(r.work), 'outdocs');
    fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'agents', 'repo.md'), 'TODO(repo-defaults) one\nTODO(repo-defaults) two\n');
    fs.symlinkSync(outDir, path.join(r.work, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    const i = run(r, '--inspect', '--json');
    assert.equal(i.status, 0, i.err);
    assert.equal(i.json.items.find((x) => x.name === 'docs/agents/repo.md').status, 'invalid');
    assert.equal(i.json.todo, null, 'no TODO markers counted from outside the repo');
    assert.doesNotMatch(run(r, '--inspect').out, /TODO markers/);
  });

  test('a dangling docs/agents/repo.md link is invalid and left as it is', (t) => {
    const r = repo();
    fs.mkdirSync(path.join(r.work, 'docs', 'agents'), { recursive: true });
    try { fs.symlinkSync(path.join('..', '..', 'missing-facts.md'), path.join(r.work, 'docs', 'agents', 'repo.md'), 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    assert.equal(a.json.items.find((i) => i.name === 'docs/agents/repo.md').status, 'invalid');
    assert.ok(fs.lstatSync(path.join(r.work, 'docs', 'agents', 'repo.md')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(r.work, 'missing-facts.md')), false);
  });

  test('skill commands use "$HOME/..." (PowerShell 5.1 passes ~ to node literally)', () => {
    for (const f of [path.join(SKILL, 'SKILL.md'), path.join(SKILL, 'assets', 'agents-block.md'), path.join(SKILL, '..', 'exact_land-queue', 'SKILL.md')]) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /node ~\//, f);
    }
  });

  test('a link to nothing is invalid and left as it is', (t) => {
    const r = repo();
    try { fs.symlinkSync(path.join('docs', 'missing.md'), path.join(r.work, 'AGENTS.md'), 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    assert.equal(a.json.items.find((i) => i.name === 'AGENTS.md block').status, 'invalid');
    assert.ok(fs.lstatSync(path.join(r.work, 'AGENTS.md')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(r.work, 'docs', 'missing.md')), false);
  });

  test('CLAUDE.md linked to another repo\'s AGENTS.md is invalid; a link to this one (not created yet) is ok', (t) => {
    const r = repo();
    const other = path.join(path.dirname(r.work), 'other repo');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'AGENTS.md'), `${BLOCK}\n`);
    try { fs.symlinkSync(path.join('..', 'other repo', 'AGENTS.md'), path.join(r.work, 'CLAUDE.md'), 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode on Windows'); return; }
      throw e;
    }
    const a = run(r, '--inspect', '--json');
    assert.equal(a.json.items.find((i) => i.name === 'CLAUDE.md').status, 'invalid');
    fs.unlinkSync(path.join(r.work, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(r.work, 'CLAUDE.md'), 'file');
    assert.equal(run(r, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'ok');
    assert.equal(run(r, '--apply').status, 0);
    assert.ok(fs.lstatSync(path.join(r.work, 'CLAUDE.md')).isSymbolicLink());
  });

  test('t3.json: an engine script with extra repo fields is kept; a manual script keeps its async', () => {
    const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'assets', 't3.json'), 'utf8'));
    const withIcon = { ...want.scripts[0], icon: 'rocket' };
    const manual = { name: 'Watch', command: 'npm run watch', async: true };
    const r = repo({ 't3.json': JSON.stringify({ defaultThreadEnvMode: 'local', scripts: [withIcon, manual] }) });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 0, a.out);
    const t3 = JSON.parse(read(r, 't3.json'));
    assert.deepEqual(t3.scripts.map((s) => s.name), ['Agent setup', 'Agent teardown', 'Agent setup', 'Watch']);
    assert.equal(t3.scripts[2].icon, 'rocket');
    assert.equal(t3.scripts[3].async, true);
    assert.match(a.json.actions.join('\n'), /custom script\(s\) that call agent-worktree kept/);
  });

  test('t3.json: a field named like an Object prototype member (constructor) still counts as extra', () => {
    const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'assets', 't3.json'), 'utf8'));
    const r = repo({ 't3.json': JSON.stringify({ defaultThreadEnvMode: 'local', scripts: [{ ...want.scripts[0], constructor: 'repo field' }] }) });
    assert.equal(run(r, '--apply').status, 0);
    const t3 = JSON.parse(read(r, 't3.json'));
    assert.ok(t3.scripts.some((s) => Object.hasOwn(s, 'constructor') && s.constructor === 'repo field'), 'kept');
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

  test('a newer managed block (from a newer skill) is reported and never rewritten', () => {
    const newer = BLOCK.replace(/agent-standard v1/g, 'agent-standard v2').replace('(v1)', '(v2)');
    const text = `${newer}\n\nOwned.\n`;
    const r = repo({ 'AGENTS.md': text });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    const item = a.json.items.find((i) => i.name === 'AGENTS.md block');
    assert.equal(item.status, 'invalid');
    assert.match(item.detail, /v2 is newer than this skill's v1/);
    assert.equal(read(r, 'AGENTS.md'), text);
  });

  test('repo.json: a missing version is added with the other keys; an explicit other version is refused', () => {
    const r = repo({ '.agents/repo.json': JSON.stringify({ repo: 'x', vault: 'agent-repos', gate: ['make gate'] }) });
    assert.equal(run(r, '--apply').status, 0);
    const rj = JSON.parse(read(r, '.agents/repo.json'));
    assert.equal(rj.version, 1);
    assert.deepEqual(rj.gate, ['make gate']);
    const r2 = repo({ '.agents/repo.json': JSON.stringify({ version: 2, vault: 'agent-repos' }) });
    const a = run(r2, '--apply');
    assert.equal(a.status, 1);
    assert.match(a.out, /version is not 1/);
  });

  test('a CRLF workflow with a blank line inside on: still lists its pull_request trigger', () => {
    const r = repo({ '.github/workflows/ci.yml': 'name: ci\r\non:\r\n  push:\r\n\r\n  pull_request:\r\njobs: {}\r\n' });
    assert.deepEqual(run(r, '--inspect', '--json').json.gatingWorkflows, [{ file: '.github/workflows/ci.yml', triggers: ['pull_request'] }]);
  });

  test('an inherited GIT_INDEX_FILE (outer repo) is never touched by the fixture', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'outer repo '));
    temps.push(outer);
    const oe = env(outer);
    git(outer, oe, 'init', '--quiet', outer);
    fs.writeFileSync(path.join(outer, 'staged.txt'), 'staged\n');
    git(outer, oe, 'add', 'staged.txt');
    const index = path.join(outer, '.git', 'index');
    const before = fs.readFileSync(index);
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = index;
    try {
      repo({ 'a.txt': 'a\n' });
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
    }
    assert.ok(fs.readFileSync(index).equals(before), 'the outer index is byte-identical');
  });

  test('inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (an outer repo) never redirect apply; --repo is used', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'outer repo '));
    temps.push(outer);
    const oe = env(outer);
    git(outer, oe, 'init', '--quiet', outer);
    fs.writeFileSync(path.join(outer, 'staged.txt'), 'staged\n');
    git(outer, oe, 'add', 'staged.txt');
    const index = path.join(outer, '.git', 'index');
    const before = fs.readFileSync(index);
    const r = repo();
    const e = { ...r.e, GIT_DIR: path.join(outer, '.git'), GIT_WORK_TREE: outer, GIT_INDEX_FILE: index };
    const p = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--apply', '--offline', '--json'], { env: e, encoding: 'utf8', shell: false });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.equal(JSON.parse(p.stdout).root, fs.realpathSync(r.work));
    assert.ok(fs.readFileSync(path.join(r.work, 'AGENTS.md'), 'utf8').startsWith(BLOCK), 'the --repo target was changed');
    assert.equal(fs.existsSync(path.join(outer, 'AGENTS.md')), false, 'the outer repo was not');
    assert.ok(fs.readFileSync(index).equals(before), 'the outer index is byte-identical');
  });

  test('the temp file is created exclusively: a file or link already at its path is left alone', async (t) => {
    const { replaceVia } = await import(pathToFileURL(APPLY).href);
    assert.equal(typeof replaceVia, 'function');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp guard '));
    temps.push(dir);
    const target = path.join(dir, 'AGENTS.md');
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(target, 'target\n');
    fs.writeFileSync(outside, 'outside\n');
    const planted = path.join(dir, 'AGENTS.md.planted.tmp');
    fs.writeFileSync(planted, 'planted\n');
    assert.throws(() => replaceVia(planted, target, 'new\n', undefined, false), /EEXIST/);
    assert.equal(fs.readFileSync(planted, 'utf8'), 'planted\n', 'a planted file is not overwritten or removed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'target\n');
    let link = path.join(dir, 'AGENTS.md.link.tmp');
    try { fs.symlinkSync(outside, link, 'file'); } catch (e) {
      if (e.code === 'EPERM') { t.diagnostic('symlink case needs Developer Mode on Windows'); link = null; } else throw e;
    }
    if (link) {
      assert.throws(() => replaceVia(link, target, 'new\n', undefined, false), /EEXIST/);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n', 'nothing written through the link');
      assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link is left in place');
    }
  });

  test('a .github/workflows that cannot be listed is reported; the apply actions still are', () => {
    const r = repo({ '.github/workflows': 'a file, not a folder\n' });
    const a = run(r, '--apply', '--json');
    assert.ok(a.json, a.err);
    assert.ok(a.json.actions.length > 0, 'actions reported');
    assert.match(a.json.gatingWorkflowsError, /could not be listed/);
    assert.match(run(r, '--inspect').out, /WARN {2}\.github\/workflows could not be listed/);
  });

  test('a BEGIN without its END before a second block: invalid, the repo text between is untouched', () => {
    const text = `${BLOCK.replace('<!-- END agent-standard -->', '')}\n\nRepo text that must stay.\n\n${BLOCK.replace(/v1/g, 'v0')}\n`;
    const r = repo({ 'AGENTS.md': text });
    const a = run(r, '--apply', '--json');
    assert.equal(a.status, 1);
    const item = a.json.items.find((i) => i.name === 'AGENTS.md block');
    assert.equal(item.status, 'invalid');
    assert.match(item.detail, /BEGIN marker without its END/);
    assert.equal(read(r, 'AGENTS.md'), text);
  });

  test('a complete block followed by an unmatched BEGIN: invalid, untouched', () => {
    const text = `${BLOCK}\n\nRepo text.\n\n<!-- BEGIN agent-standard v1 -->\nhalf a block\n`;
    const r = repo({ 'AGENTS.md': text });
    const a = run(r, '--check', '--json');
    assert.equal(a.status, 1);
    const item = a.json.items.find((i) => i.name === 'AGENTS.md block');
    assert.equal(item.status, 'invalid');
    assert.match(item.detail, /2 BEGIN markers but 1 complete block/);
    assert.equal(run(r, '--apply').status, 1);
    assert.equal(read(r, 'AGENTS.md'), text);
  });

  test('CLI: --repo without a path and two modes at once exit 2 before any write', () => {
    const r = repo();
    for (const args of [['--apply', '--repo'], ['--repo', '--apply'], ['--apply', '--check']]) {
      const p = spawnSync(process.execPath, [APPLY, ...args], { cwd: r.work, env: r.e, encoding: 'utf8', shell: false });
      assert.equal(p.status, 2, `${args.join(' ')}: ${p.stdout}${p.stderr}`);
      assert.equal(fs.existsSync(path.join(r.work, 'AGENTS.md')), false, `${args.join(' ')} wrote nothing`);
    }
  });

  test('a rewritten file keeps its exact mode (0664 under umask 022), on both write paths', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX modes'); return; }
    const old = '<!-- BEGIN agent-standard v0 -->\nold\n<!-- END agent-standard -->\n';
    const r = repo({ 'AGENTS.md': old, 'CLAUDE.md': 'Claude note.\n' });
    fs.chmodSync(path.join(r.work, 'AGENTS.md'), 0o664);
    fs.chmodSync(path.join(r.work, 'CLAUDE.md'), 0o664);
    // CLAUDE.md gets a second name: its write goes the in-place (several hard links) way.
    fs.linkSync(path.join(r.work, 'CLAUDE.md'), path.join(path.dirname(r.work), 'claude-other-name.md'));
    const saved = process.umask(0o022);
    try {
      assert.equal(run(r, '--apply').status, 0);
    } finally {
      process.umask(saved);
    }
    assert.equal(fs.statSync(path.join(r.work, 'AGENTS.md')).mode & 0o777, 0o664, 'rename path');
    assert.equal(fs.statSync(path.join(r.work, 'CLAUDE.md')).mode & 0o777, 0o664, 'in-place path');
    assert.match(read(r, 'CLAUDE.md'), /^@AGENTS\.md/);
  });

  test('docs/agents/repo.md with every placeholder filled counts no TODO marker', () => {
    const r = repo();
    assert.equal(run(r, '--apply').status, 0);
    const p = path.join(r.work, 'docs', 'agents', 'repo.md');
    fs.writeFileSync(p, read(r, 'docs/agents/repo.md').replace(/TODO\(repo-defaults\)$/gm, 'filled'));
    const rj = path.join(r.work, '.agents', 'repo.json');
    fs.writeFileSync(rj, read(r, '.agents/repo.json').replace(/TODO\(repo-defaults\)[^"]*/g, 'filled'));
    assert.equal(run(r, '--inspect', '--json').json.todo, null);
  });

  test('an @AGENTS.md import inside a fenced code block is not an import (``` and ~~~)', () => {
    for (const fence of ['```', '~~~~']) {
      const text = ['Example:', '', `${fence}md`, '@AGENTS.md', fence, ''].join('\n');
      const r = repo({ 'CLAUDE.md': text });
      assert.equal(run(r, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'missing', fence);
      assert.equal(run(r, '--apply').status, 0);
      assert.equal(read(r, 'CLAUDE.md'), `@AGENTS.md\n\n${text}`, `${fence}: the real import is added, the example kept`);
    }
  });

  test('a leading BOM stays first; a BOM never hides a fence or an import', () => {
    const BOM = '\uFEFF';
    // AGENTS.md: the block goes after the BOM.
    const a = repo({ 'AGENTS.md': `${BOM}# Rules\n` });
    assert.equal(run(a, '--apply').status, 0);
    assert.equal(read(a, 'AGENTS.md'), `${BOM}${BLOCK}\n\n# Rules\n`);
    // CLAUDE.md: an example in a fence that starts the file is not an import.
    const fence = '```';
    const body = [`${fence}md`, '@AGENTS.md', fence, ''].join('\n');
    const c = repo({ 'CLAUDE.md': `${BOM}${body}` });
    assert.equal(run(c, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'missing');
    assert.equal(run(c, '--apply').status, 0);
    assert.equal(read(c, 'CLAUDE.md'), `${BOM}@AGENTS.md\n\n${body}`);
    // A real import on the first line after a BOM is an import.
    const ok = repo({ 'CLAUDE.md': `${BOM}@AGENTS.md\n` });
    assert.equal(run(ok, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'ok');
  });

  test('rulesets: every page, each read in full; only required checks and merge queues listed; unreadable ones reported', () => {
    const r = repo();
    git(r.work, r.e, 'remote', 'set-url', 'origin', 'https://github.com/o/sample-app.git');
    const bin = path.join(path.dirname(r.work), 'fake bin');
    fs.mkdirSync(bin);
    const fake = path.join(bin, 'fake-gh.mjs');
    fs.writeFileSync(fake, [
      "import { spawnSync } from 'node:child_process';",
      'const [tool, ...args] = process.argv.slice(2);',
      "if (tool === 'git') process.exit(spawnSync(process.env.REC_REAL_GIT, args, { stdio: 'inherit' }).status ?? 1);",
      'const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };',
      "const all = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, enforcement: 'active', target: 'branch' }));",
      "const route = args.find((a) => a.startsWith('repos/'));",
      "const f = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === '-f' ? [a.split('=')] : [])));",
      "if (route === 'repos/o/sample-app/rulesets') {",
      '  const n = Number(f.per_page || 30); const p = Number(f.page || 1);',
      '  out(all.slice((p - 1) * n, p * n));',
      '}',
      "if (route && route.startsWith('repos/o/sample-app/rulesets/')) {",
      "  const id = Number(route.split('/').pop());",
      '  if (id === 50) process.exit(1);',
      "  out({ id, rules: id === 1 ? [{ type: 'required_status_checks' }, { type: 'deletion' }] : id === 101 ? [{ type: 'merge_queue' }] : [{ type: 'deletion' }] });",
      '}',
      'process.exit(1);',
    ].join('\n'));
    for (const tool of ['git', 'gh']) {
      if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@"${process.execPath}" "${fake}" ${tool} %*\r\n`);
      else { fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${tool} "$@"\n`); fs.chmodSync(path.join(bin, tool), 0o755); }
    }
    const pk = Object.keys(r.e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const e = { ...r.e, [pk]: `${bin}${path.delimiter}${r.e[pk]}`, REC_REAL_GIT: GIT };
    const j = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--inspect', '--json'], { env: e, encoding: 'utf8', shell: false });
    assert.equal(j.status, 0, j.stderr);
    const rs = JSON.parse(j.stdout).rulesets;
    assert.deepEqual(rs.list, [
      { name: 'r1', enforcement: 'active', target: 'branch', rules: ['required_status_checks'] },
      { name: 'r101', enforcement: 'active', target: 'branch', rules: ['merge_queue'] },
    ]);
    assert.deepEqual(rs.unreadable, [{ name: 'r50', id: 50 }]);
    assert.equal(rs.incomplete, null);
    const txt = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--inspect'], { env: e, encoding: 'utf8', shell: false });
    assert.match(txt.stdout, /INFO {2}ruleset r1 \(active\) has required_status_checks: drop only those rules/);
    assert.match(txt.stdout, /WARN {2}ruleset r50: its rules could not be read/);
    assert.doesNotMatch(txt.stdout, /ruleset r2 /, 'a ruleset with no gating rule is not reported');
  });

  test('CLAUDE.md: every documented form of the import counts; look-alikes and code do not', () => {
    for (const text of ['@./AGENTS.md\n', 'See @AGENTS.md for the rules.\n', '# Rules\n\n- shared @AGENTS.md\n', '@AGENTS.md\t\n']) {
      const r = repo({ 'CLAUDE.md': text });
      assert.equal(run(r, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'ok', JSON.stringify(text));
      assert.equal(run(r, '--apply').status, 0);
      assert.equal(read(r, 'CLAUDE.md'), text, `${JSON.stringify(text)}: no second import`);
    }
    for (const text of ['`@AGENTS.md`\n', '@AGENTS.md-old\n', 'Read @AGENTS.md.\n', '(@AGENTS.md)\n','"@AGENTS.md"\n', '@AGENTS.mdx\n']) {
      const r = repo({ 'CLAUDE.md': text });
      assert.equal(run(r, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'missing', JSON.stringify(text));
    }
  });

  // A code span closes only on a backtick run of exactly its opening length (CommonMark): a
  // longer or shorter run inside it is content, so an example inside never counts as an import.
  test('CLAUDE.md: code spans with unequal backtick runs inside hide the example; real imports after spans count', () => {
    const status = (text) => run(repo({ 'CLAUDE.md': text }), '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status;
    for (const text of ['Example: `literal ``` @AGENTS.md `\n', 'See ``` a ` @AGENTS.md `` b ``` here\n', 'See ``a ` @AGENTS.md`` here\n']) {
      assert.equal(status(text), 'missing', JSON.stringify(text));
    }
    for (const text of ['Use `a` and @AGENTS.md\n', 'Run ``` x `` y ``` then @AGENTS.md\n']) {
      assert.equal(status(text), 'ok', JSON.stringify(text));
    }
  });

  test('t3.json: the legacy $HOME engine scripts (cmd.exe cannot expand them) are replaced', () => {
    const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'assets', 't3.json'), 'utf8'));
    const legacy = want.scripts.map((s, i) => ({ ...s, command: `node "$HOME/.agents/bin/agent-worktree.mjs" ${['setup', 'teardown'][i]}` }));
    const r = repo({ 't3.json': JSON.stringify({ defaultThreadEnvMode: 'worktree', scripts: legacy }) });
    const item = run(r, '--inspect', '--json').json.items.find((i) => i.name === 't3.json');
    assert.equal(item.status, 'outdated');
    assert.match(item.detail, /\$HOME, which cmd\.exe does not expand/);
    assert.equal(run(r, '--apply').status, 0);
    assert.deepEqual(JSON.parse(read(r, 't3.json')).scripts, want.scripts, 'legacy copies dropped, nothing kept as custom');
  });

  // The asset's commands, run by each shell T3 may use, reach the engine as its direct entry
  // point with the right command (a stub engine in a fake home records what it saw).
  test('t3.json commands run the engine from cmd.exe, PowerShell and sh alike', () => {
    const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'assets', 't3.json'), 'utf8'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo defaults home '));
    temps.push(home);
    fs.mkdirSync(path.join(home, '.agents', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'bin', 'agent-worktree.mjs'), [
      "import fs from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'const direct = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));',
      'process.stdout.write(JSON.stringify({ direct, args: process.argv.slice(2) }));',
    ].join('\n'));
    const onPath = (exe) => spawnSync(process.platform === 'win32' ? 'where.exe' : 'sh', process.platform === 'win32' ? [exe] : ['-c', `command -v ${exe}`], { encoding: 'utf8' }).status === 0;
    const shells = process.platform === 'win32' ? [true, 'powershell.exe', 'pwsh.exe'].filter((s) => s === true || onPath(s)) : ['/bin/sh', 'pwsh'].filter((s) => s === '/bin/sh' || onPath(s));
    assert.ok(shells.length >= (process.platform === 'win32' ? 2 : 1));
    for (const shell of shells) {
      for (const [i, word] of [[0, 'setup'], [1, 'teardown']]) {
        const r = spawnSync(want.scripts[i].command, { shell, cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
        assert.equal(r.status, 0, `${shell} ${word}: ${r.stderr}`);
        assert.deepEqual(JSON.parse(r.stdout), { direct: true, args: [word] }, `${shell} ${word}`);
      }
    }
  });

  test('CLAUDE.md: a code span never crosses a blank line; inside one paragraph it can span lines', () => {
    const across = ['Use a ` tick here.', '', '@AGENTS.md and a ` tick', ''].join('\n');
    const r = repo({ 'CLAUDE.md': across });
    assert.equal(run(r, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'ok');
    assert.equal(run(r, '--apply').status, 0);
    assert.equal(read(r, 'CLAUDE.md'), across, 'no second import');
    const inside = repo({ 'CLAUDE.md': 'See `a\n  @AGENTS.md` here\n' });
    assert.equal(run(inside, '--inspect', '--json').json.items.find((i) => i.name === 'CLAUDE.md').status, 'missing');
  });

  test('.agents/repo.json: a missing itemPrefix follows the existing repo name; an explicit one is kept', () => {
    const r = repo({ '.agents/repo.json': JSON.stringify({ version: 1, repo: 'custom-name' }) });
    assert.equal(run(r, '--apply').status, 0);
    const rj = JSON.parse(read(r, '.agents/repo.json'));
    assert.equal(rj.itemPrefix, 'custom-name', 'not the name detected from origin');
    assert.equal(rj.repo, 'custom-name');
    const k = repo({ '.agents/repo.json': JSON.stringify({ version: 1, repo: 'custom-name', itemPrefix: 'kept-prefix' }) });
    assert.equal(run(k, '--apply').status, 0);
    assert.equal(JSON.parse(read(k, '.agents/repo.json')).itemPrefix, 'kept-prefix');
  });

  test('yarn: the install flag follows the Yarn version from the repo metadata; unknown is a TODO', () => {
    const install = (files) => run(repo(files), '--inspect', '--json').json.detection.install;
    const pkg = (pm) => JSON.stringify({ name: 'x', ...(pm ? { packageManager: pm } : {}) });
    assert.equal(install({ 'package.json': pkg('yarn@1.22.22'), 'yarn.lock': '' }), 'yarn install --frozen-lockfile');
    assert.equal(install({ 'package.json': pkg('yarn@4.5.0'), 'yarn.lock': '' }), 'yarn install --immutable');
    assert.equal(install({ 'package.json': pkg(), 'yarn.lock': '# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n' }), 'yarn install --frozen-lockfile');
    assert.equal(install({ 'package.json': pkg(), 'yarn.lock': '__metadata:\n  version: 8\n' }), 'yarn install --immutable');
    assert.equal(install({ 'package.json': pkg(), 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' }), 'yarn install --immutable');
    assert.match(install({ 'package.json': pkg(), 'yarn.lock': '' }), /^TODO\(repo-defaults\): yarn install command/);
  });

  test('env report: tracked env files below the root are listed (counts only); untracked ones are not', () => {
    const r = repo({
      'packages/api/.env': 'API_KEY=plainvalue1\nOTHER=plainvalue2\n',
      'apps/web/.env.production': 'WEB_KEY=plainvalue3\n',
      'apps/web/.env.example': 'WEB_KEY=\n',
      'packages/api/.env.op': 'API_KEY=op://agent-repos/x/API_KEY\n',
    });
    fs.mkdirSync(path.join(r.work, 'apps', 'other'), { recursive: true });
    fs.writeFileSync(path.join(r.work, 'apps', 'other', '.env'), 'LOCAL=plainvalue4\n');
    const p = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--inspect', '--json'], { env: r.e, encoding: 'utf8', shell: false });
    const files = JSON.parse(p.stdout).env.files;
    const by = Object.fromEntries(files.map((f) => [f.file, f]));
    assert.deepEqual(by['packages/api/.env'], { file: 'packages/api/.env', keys: 2, tracked: true, role: 'source' });
    assert.deepEqual(by['apps/web/.env.production'], { file: 'apps/web/.env.production', keys: 1, tracked: true, role: 'source' });
    assert.equal(by['apps/web/.env.example'].role, 'template');
    assert.equal(by['packages/api/.env.op'], undefined, 'a nested .env.op holds references, not values');
    assert.equal(by['apps/other/.env'], undefined, 'untracked files below the root are not scanned');
    const txt = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--inspect', '--offline'], { env: r.e, encoding: 'utf8', shell: false }).stdout;
    assert.match(txt, /INFO {2}packages\/api\/\.env: 2 keys \(TRACKED IN GIT: remove it and rotate\)/);
    assert.doesNotMatch(p.stdout + txt, /plainvalue/, 'no values');
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
    // --apply lists rulesets once (for the final report), not before the fixes too.
    fs.writeFileSync(log, '');
    const a = spawnSync(process.execPath, [APPLY, '--repo', r.work, '--apply', '--json'], { env: e, encoding: 'utf8', shell: false });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('gh ')).length, 1);
  });

  test('BEGIN without END is reported and never touched', () => {
    const text = '<!-- BEGIN agent-standard v1 -->\nhalf\n';
    const r = repo({ 'AGENTS.md': text });
    assert.equal(run(r, '--apply').status, 1);
    assert.equal(read(r, 'AGENTS.md'), text);
  });
});
