// Shared fixtures for the lifecycle tool tests: a scratch dir (with a space in its path), a
// real git repo with a local bare remote, and fake gh/docker/op on PATH. No network, no real
// credentials, no real home.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(here, '..', '..', 'home', 'dot_agents', 'bin');
export const ENGINE = path.join(BIN, 'agent-worktree.mjs');
export const SECRET = path.join(BIN, 'agent-secret.mjs');
const FAKE = path.join(here, 'fakes', 'fake.mjs');
export const isWin = process.platform === 'win32';
export const DUMMY_TOKEN = 'dummy-service-token-for-tests-0001';

function realWhich(cmd) {
  const r = isWin
    ? spawnSync('where.exe', [cmd], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Git for Windows: the cmd\ launcher sets up its own PATH (needed for push over file://).
  const first = isWin ? lines.find((l) => /\\cmd\\[^\\]+\.exe$/i.test(l)) || lines.find((l) => /\.exe$/i.test(l)) : lines[0];
  return first || null;
}

const GIT = realWhich('git');

/** Scratch area: {dir, bin, home, state, logFile, env, cleanup}. */
export function scratch(tools = ['gh', 'docker', 'op']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent wt ')));
  const bin = path.join(dir, 'fake bin');
  const home = path.join(dir, 'home');
  const tooldir = path.join(dir, 'tools');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(tooldir);
  for (const t of tools) installFake(bin, t);
  const pathDirs = [bin];
  if (isWin) {
    pathDirs.push(path.dirname(GIT), path.dirname(process.execPath));
  } else {
    fs.symlinkSync(GIT, path.join(tooldir, 'git'));
    fs.symlinkSync(process.execPath, path.join(tooldir, 'node'));
    pathDirs.push(tooldir);
    for (const d of ['/usr/bin', '/bin']) if (fs.existsSync(d)) pathDirs.push(d);
  }
  const state = path.join(dir, 'fake-state.json');
  const logFile = path.join(dir, 'fake-log.jsonl');
  fs.writeFileSync(state, JSON.stringify({ gh: { prs: [] }, docker: { containers: [], volumes: [], networks: [] }, op: { items: [], vaults: [{ id: 'v1', name: 'agent-repos' }] } }));
  fs.writeFileSync(logFile, '');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PATH|OP_|T3CODE_|GH_|GITHUB_|GIT_|AGENT_|DOCKER_)/i.test(k)) continue;
    if (/^(HOME|USERPROFILE|LOCALAPPDATA|APPDATA|XDG_)/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    [isWin ? 'Path' : 'PATH']: pathDirs.join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    AGENT_ENV_NO_SECRETS: '1',
    AGENT_WORKTREE_NO_SWEEP: '1',
    AGENT_WORKTREE_T3_ROOT: path.join(home, '.t3', 'worktrees'),
    FAKE_STATE: state,
    FAKE_LOG: logFile,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  return {
    dir, bin, home, env,
    readState: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    writeState: (fn) => { const s = JSON.parse(fs.readFileSync(state, 'utf8')); fn(s); fs.writeFileSync(state, JSON.stringify(s, null, 2)); },
    calls: (tool) => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !tool || c.tool === tool),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

export function installFake(bin, tool) {
  if (isWin) {
    fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@"${process.execPath}" "${FAKE}" ${tool} %*\r\n`);
  } else {
    const f = path.join(bin, tool);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
}

export function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitIn(s, cwd, ...args) { return sh(GIT, args, cwd, s.env); }

export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * Repo fixture: bare remote, main checkout ("main repo") with .agents/repo.json, and one
 * worktree ("wt one", or opts.wtName) on agent/LEE-1-feature with one pushed commit.
 */
export function makeRepo(s, opts = {}) {
  const remote = path.join(s.dir, 'remote.git');
  const main = path.join(s.dir, 'main repo');
  sh(GIT, ['init', '-q', '--bare', '-b', 'main', remote], s.dir, s.env);
  fs.mkdirSync(main);
  gitIn(s, main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'README.md'), 'demo\n');
  write(path.join(main, '.gitignore'), '.env.local\nscratch/\n');
  write(path.join(main, '.agents', 'repo.json'), JSON.stringify({ version: 1, repo: 'demo', base: 'main', ...(opts.config || {}) }, null, 2));
  for (const [f, t] of Object.entries(opts.files || {})) write(path.join(main, f), t);
  gitIn(s, main, 'add', '-A');
  gitIn(s, main, 'commit', '-q', '-m', 'init');
  gitIn(s, main, 'remote', 'add', 'origin', remote);
  gitIn(s, main, 'push', '-q', '-u', 'origin', 'main');
  const branch = opts.branch || 'agent/LEE-1-feature';
  const wt = opts.wtPath || path.join(s.dir, opts.wtName || 'wt one');
  gitIn(s, main, 'worktree', 'add', '-q', '-b', branch, wt);
  write(path.join(wt, 'feature.txt'), 'feature\n');
  gitIn(s, wt, 'add', '-A');
  gitIn(s, wt, 'commit', '-q', '-m', 'feature');
  if (opts.push !== false) gitIn(s, wt, 'push', '-q', '-u', 'origin', branch);
  const head = gitIn(s, wt, 'rev-parse', 'HEAD');
  const commonDir = path.join(main, '.git');
  return { remote, main, wt, branch, head, commonDir, wtId: 'demo-wt-one' };
}

export function pr(over) {
  return {
    number: 7, state: 'MERGED', headRefName: 'agent/LEE-1-feature', headRefOid: '0'.repeat(40),
    baseRefName: 'main', createdAt: '2026-11-01T00:00:00Z', url: 'https://example.com/pr/7',
    body: '', labels: [], ...over,
  };
}

export function run(script, args, cwd, env, input) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

export function engine(s, args, cwd, extraEnv = {}) { return run(ENGINE, args, cwd, { ...s.env, ...extraEnv }); }
export function secret(s, args, cwd, input, extraEnv = {}) { return run(SECRET, args, cwd, { ...s.env, ...extraEnv }, input); }

export function ledgerOf(repo, wtId = repo.wtId) {
  const f = path.join(repo.commonDir, 'agent-resources', `${wtId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
