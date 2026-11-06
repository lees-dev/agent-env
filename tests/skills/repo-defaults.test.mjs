// Tests for home/dot_agents/skills/exact_repo-defaults/scripts/apply.mjs on temp git repos.
// Run: node --test "tests/**/*.test.mjs"
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
  return { status: p.status, out: p.stdout, err: p.stderr, json: args.includes('--json') ? JSON.parse(p.stdout) : null };
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
    assert.equal(files['.env.local'].tracked, false);
    assert.doesNotMatch(JSON.stringify(i.json), /value/, 'no env values in the output');
  });

  test('BEGIN without END is reported and never touched', () => {
    const text = '<!-- BEGIN agent-standard v1 -->\nhalf\n';
    const r = repo({ 'AGENTS.md': text });
    assert.equal(run(r, '--apply').status, 1);
    assert.equal(read(r, 'AGENTS.md'), text);
  });
});
