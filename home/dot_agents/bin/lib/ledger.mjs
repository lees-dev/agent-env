// Per-worktree resource ledger and the per-user repo registry (~/.agents/bin).
// Ledger: <git-common-dir>/agent-resources/<wtId>.json, outside the worktree so it survives
// the worktree's removal. Writes are atomic (temp file + rename) under a per-ledger lock file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './op.mjs';
import { sleepMs } from './proc.mjs';
import { normPath } from './repo.mjs';

const LOCK_WAIT_MS = 15000;
const LOCK_EMPTY_GRACE_MS = 5000;

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

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Take a lock file without waiting. The file holds "<pid> <random token>"; a lock whose pid
 * is dead is broken, a live holder means busy (null). Returns a release function that removes
 * the file only while it still holds our token.
 */
export function tryLock(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held;
      let st;
      try { held = fs.readFileSync(lock, 'utf8'); st = fs.statSync(lock); } catch { continue; }
      // A holder between create and write leaves an empty file for a moment.
      if (!held && Date.now() - st.mtimeMs < LOCK_EMPTY_GRACE_MS) return null;
      if (pidAlive(Number(held.split(' ')[0]))) return null;
      try { if (fs.readFileSync(lock, 'utf8') === held) fs.unlinkSync(lock); } catch { /* raced */ }
    }
  }
  return null;
}

/** Run fn while holding <file>.lock, waiting up to 15 s for a live holder. */
export function withLock(file, fn) {
  const release = waitLock(`${file}.lock`);
  try { return fn(); } finally { release(); }
}

/** Async variant of withLock (the wait itself is synchronous and short). */
export async function withLockAsync(file, fn) {
  const release = waitLock(`${file}.lock`);
  try { return await fn(); } finally { release(); }
}

function waitLock(lock) {
  const start = Date.now();
  for (;;) {
    const release = tryLock(lock);
    if (release) return release;
    if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`lock busy: ${path.basename(lock)}`);
    sleepMs(50);
  }
}

const PATH_KINDS = new Set(['file', 'dir', 'cache', 'path']);
export function isPathKind(kind) { return PATH_KINDS.has(String(kind)); }

/** Path resources are stored absolute: a relative id is resolved against the worktree. */
export function normalizeTrack(kind, id, worktreePath) {
  return isPathKind(kind) && !path.isAbsolute(String(id)) ? path.resolve(worktreePath, String(id)) : String(id);
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
