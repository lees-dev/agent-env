// Per-worktree resource ledger and the per-user repo registry (~/.agents/bin).
// Ledger: <git-common-dir>/agent-resources/<wtId>.json, outside the worktree so it survives
// the worktree's removal. Writes are atomic (temp file + rename) under a per-ledger lock file.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './op.mjs';
import { sleepMs } from './proc.mjs';
import { normPath } from './repo.mjs';

const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 120000;

export function ledgerDir(commonDir) { return path.join(commonDir, 'agent-resources'); }
export function ledgerFile(commonDir, wtId) { return path.join(ledgerDir(commonDir), `${wtId}.json`); }

/** Write JSON atomically (mode 0600). */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: a reader holding the file open makes rename fail briefly.
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw e;
      }
      sleepMs(50);
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Run fn while holding <file>.lock (exclusive create; a lock older than 2 minutes is broken). */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, `${process.pid}\n`);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`lock busy: ${path.basename(lock)}`);
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(lock); } catch { /* removed */ }
  }
}

export function readLedger(commonDir, wtId) {
  return readJson(ledgerFile(commonDir, wtId), null);
}

/** All ledgers of one repo: [{file, data}]. */
export function listLedgers(commonDir) {
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir(commonDir)).filter((n) => n.endsWith('.json'));
  } catch { return []; }
  return names.sort().map((n) => {
    const file = path.join(ledgerDir(commonDir), n);
    return { file, wtId: n.slice(0, -5), data: readJson(file, null) };
  }).filter((l) => l.data);
}

/** Read-modify-write a ledger under its lock. fn gets the current object (or a fresh one). */
export function updateLedger(commonDir, wtId, fn, init = {}) {
  const file = ledgerFile(commonDir, wtId);
  return withLock(file, () => {
    const cur = readJson(file, null) || {
      repo: null, repoRoot: null, worktreePath: null, branch: null, ticket: null,
      ports: {}, createdAt: new Date().toISOString(), state: 'active', prNumber: null,
      resources: [], ...init,
    };
    if (!Array.isArray(cur.resources)) cur.resources = [];
    const next = fn(cur) || cur;
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, next);
    return next;
  });
}

export function deleteLedger(commonDir, wtId) {
  const file = ledgerFile(commonDir, wtId);
  withLock(file, () => { try { fs.unlinkSync(file); } catch { /* gone */ } });
}

export function addResource(ledger, kind, id, where) {
  const key = (r) => `${r.kind}\u0000${r.id}`;
  const entry = { kind: String(kind), id: String(id), where: where ? String(where) : 'local' };
  if (!ledger.resources.some((r) => key(r) === key(entry))) ledger.resources.push(entry);
  return ledger;
}

export function removeResource(ledger, kind, id) {
  ledger.resources = ledger.resources.filter((r) => !(r.kind === String(kind) && r.id === String(id)));
  return ledger;
}

// ---- registry of repos this user's worktrees came from: ~/.agents/state/repos.json

export function registryFile(env = process.env) {
  return path.join(homeDir(env), '.agents', 'state', 'repos.json');
}

export function readRegistry(env = process.env) {
  const data = readJson(registryFile(env), null);
  return data && Array.isArray(data.repos) ? data : { version: 1, repos: [] };
}

export function registerRepo(repoRoot, name, env = process.env) {
  const file = registryFile(env);
  withLock(file, () => {
    const data = readRegistry(env);
    const key = normPath(repoRoot);
    const hit = data.repos.find((r) => normPath(r.root) === key);
    const now = new Date().toISOString();
    if (hit) { hit.name = name; hit.lastSeen = now; } else data.repos.push({ root: repoRoot, name, lastSeen: now });
    writeJsonAtomic(file, data);
  });
}
