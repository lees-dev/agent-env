// Repo identity and .agents/repo.json for the agent lifecycle tools (~/.agents/bin).
import fs from 'node:fs';
import path from 'node:path';
import { gitOut, isWindows } from './proc.mjs';

export const DEFAULTS = Object.freeze({
  version: 1,
  repo: null,
  base: null,
  vault: 'agent-repos',
  itemPrefix: null,
  env: { template: '.env.op', output: '.env.local' },
  ports: {},
  setup: [],
  gate: [],
  affectedGate: [],
  mergeMethod: 'squash',
  mergeCmd: null,
  ghWrapper: null,
  branchPattern: '^agent/([A-Z]+-\\d+)',
  remoteBranchDelete: '^(agent|revert)/',
  sweepEveryMerges: 5,
  wideSweep: null,
  lockTtlMin: 45,
});

/** Normalise a path for comparisons: resolved, forward slashes, lower case on Windows. */
export function normPath(p) {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? r.toLowerCase() : r;
}

export function samePath(a, b) { return normPath(a) === normPath(b); }

/** True when child is parent or inside it. */
export function isUnder(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p + '/');
}

/** 32-bit FNV-1a of a string. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(String(str), 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `<repo>-<basename>` reduced to [a-z0-9-], at most 40 characters (hash suffix when cut). */
export function makeWtId(repo, worktreePath) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const full = clean(`${repo}-${path.basename(path.resolve(worktreePath))}`) || 'wt';
  if (full.length <= 40) return full;
  const suffix = fnv1a(full).toString(16).padStart(8, '0').slice(0, 6);
  return `${full.slice(0, 33).replace(/-+$/, '')}-${suffix}`;
}

/** Read .agents/repo.json from dir (if any) merged over DEFAULTS. Throws on invalid JSON. */
export function loadConfig(dir) {
  const file = path.join(dir, '.agents', 'repo.json');
  let raw = {};
  let found = false;
  if (fs.existsSync(file)) {
    found = true;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`.agents/repo.json is not valid JSON: ${e.message}`);
    }
    if (raw.version !== undefined && raw.version !== 1) {
      throw new Error(`.agents/repo.json version ${raw.version} is not supported (expected 1)`);
    }
  }
  const cfg = { ...DEFAULTS, ...raw, env: { ...DEFAULTS.env, ...(raw.env || {}) } };
  for (const k of ['setup', 'gate', 'affectedGate']) {
    if (!Array.isArray(cfg[k])) cfg[k] = cfg[k] ? [cfg[k]] : [];
  }
  if (!cfg.ports || typeof cfg.ports !== 'object') cfg.ports = {};
  cfg.found = found;
  return cfg;
}

/**
 * Identity of the git checkout at dir: {worktreePath, repoRoot, commonDir, isMain, branch,
 * head}. Returns null when dir is not inside a git work tree.
 */
export function gitIdentity(dir, env = process.env) {
  const o = { cwd: dir, env };
  const top = gitOut(['rev-parse', '--show-toplevel'], o);
  if (!top) return null;
  const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], o);
  const gitDir = gitOut(['rev-parse', '--path-format=absolute', '--git-dir'], o);
  if (!common || !gitDir) return null;
  const list = gitOut(['worktree', 'list', '--porcelain'], o) || '';
  const first = list.split(/\r?\n/).find((l) => l.startsWith('worktree '));
  const repoRoot = first ? path.resolve(first.slice('worktree '.length)) : path.dirname(common);
  const branchRef = gitOut(['symbolic-ref', '-q', 'HEAD'], o);
  return {
    worktreePath: path.resolve(top),
    repoRoot,
    commonDir: path.resolve(common),
    isMain: samePath(common, gitDir),
    branch: branchRef ? branchRef.replace(/^refs\/heads\//, '') : null,
    head: gitOut(['rev-parse', 'HEAD'], o),
  };
}

/** Lower-case repo name: the config's `repo`, else the origin URL's last segment, else the folder. */
export function repoName(cfg, repoRoot, env = process.env) {
  if (cfg && cfg.repo) return String(cfg.repo).toLowerCase();
  const url = gitOut(['remote', 'get-url', 'origin'], { cwd: repoRoot, env });
  if (url) {
    const m = url.replace(/\.git$/, '').match(/([^/:\\]+)$/);
    if (m) return m[1].toLowerCase();
  }
  return path.basename(repoRoot).toLowerCase();
}

/** Ticket id from the branch name via cfg.branchPattern group 1, else null. */
export function ticketOf(cfg, branch) {
  if (!branch || !cfg.branchPattern) return null;
  try {
    const m = branch.match(new RegExp(cfg.branchPattern));
    return m ? m[1] || null : null;
  } catch {
    return null;
  }
}

/** Base branch: cfg.base, else origin/HEAD, else main. */
export function baseBranch(cfg, repoRoot, env = process.env) {
  if (cfg.base) return cfg.base;
  const r = gitOut(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot, env });
  return r ? r.replace(/^origin\//, '') : 'main';
}

/** Full identity used by every command. */
export function resolveContext(dir, env = process.env) {
  const id = gitIdentity(dir, env);
  if (!id) return null;
  const cfg = loadConfig(id.isMain ? id.repoRoot : id.worktreePath);
  const repo = repoName(cfg, id.repoRoot, env);
  return {
    ...id,
    cfg,
    repo,
    wtId: makeWtId(repo, id.worktreePath),
    ticket: ticketOf(cfg, id.branch),
    base: baseBranch(cfg, id.repoRoot, env),
  };
}
