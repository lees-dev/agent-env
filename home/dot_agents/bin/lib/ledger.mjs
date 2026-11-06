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
// Teardown and sweep finish well within this; older locks belong to a crashed holder.
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;

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

/** A JSON file: its data, null when it does not exist; throws when it exists but is unreadable. */
function readExisting(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)} is unreadable (${e.code || e.message}); left as it is`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error(`${path.basename(file)} is not valid JSON; left as it is for a person to repair`);
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The holder of a lock file is gone: its pid is dead, or the lock outlived LOCK_TTL_MS. */
function stale(held, st) {
  // A holder between create and write leaves an empty file for a moment.
  if (!held) return Date.now() - st.mtimeMs >= LOCK_EMPTY_GRACE_MS;
  // A reused pid would keep a crashed holder's lock "alive" forever: cap its age.
  if (Date.now() - st.mtimeMs >= LOCK_TTL_MS) return true;
  return !pidAlive(Number(held.split(' ')[0]));
}

function readHeld(file) {
  try { return { held: fs.readFileSync(file, 'utf8'), st: fs.statSync(file) }; } catch { return null; }
}

/** Create file exclusively with token; true when it is ours. */
function create(file, token) {
  try { fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 }); return true; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

/**
 * Take a lock file without waiting. The file holds "<pid> <random token>"; a live holder
 * means busy (null). A stale lock is broken only under a second "<lock>.recover" lock, which
 * makes "check that it is still the stale holder, then delete it" one step: two processes can
 * never both break it, or delete a lock that a third one has just taken. Returns a release
 * function that removes the file only while it still holds our token.
 */
export function tryLock(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
  const release = () => {
    try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* gone */ }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(lock, token)) return release;
    const cur = readHeld(lock);
    if (!cur) continue;
    if (!stale(cur.held, cur.st)) return null;
    if (!breakStale(lock, cur.held, token)) return null;
  }
  return null;
}

/**
 * Delete lock if it still holds held, under <lock>.recover. False when someone else is at it.
 * The recovery file itself is never reclaimed automatically (that would repeat the race it
 * prevents): one left by a recoverer that crashed in this short step keeps the lock busy
 * until someone deletes it by hand.
 */
function breakStale(lock, held, token) {
  const rec = `${lock}.recover`;
  if (!create(rec, token)) return false;
  try {
    const now = readHeld(lock);
    if (now && now.held === held && stale(now.held, now.st)) fs.unlinkSync(lock);
  } catch { /* gone */ } finally {
    try { if (fs.readFileSync(rec, 'utf8') === token) fs.unlinkSync(rec); } catch { /* gone */ }
  }
  return true;
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
  return readExisting(ledgerFile(commonDir, wtId));
}

/** All ledgers of one repo: [{file, wtId, data}]; an unreadable one has data null and error set. */
export function listLedgers(commonDir) {
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir(commonDir)).filter((n) => n.endsWith('.json'));
  } catch { return []; }
  return names.sort().map((n) => {
    const file = path.join(ledgerDir(commonDir), n);
    try {
      return { file, wtId: n.slice(0, -5), data: readExisting(file) };
    } catch (e) { return { file, wtId: n.slice(0, -5), data: null, error: e.message }; }
  }).filter((l) => l.data || l.error);
}

/** Read-modify-write a ledger under its lock. fn gets the current object (or a fresh one). */
export function updateLedger(commonDir, wtId, fn, init = {}) {
  const file = ledgerFile(commonDir, wtId);
  return withLock(file, () => {
    // Never replace a ledger that exists but cannot be read: its resource records matter.
    const cur = readExisting(file) || {
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

/** The registry for an update: empty only when missing; throws when it exists but is unreadable. */
function registryForUpdate(env) {
  const data = readExisting(registryFile(env));
  if (data === null) return { version: 1, repos: [] };
  if (!Array.isArray(data.repos)) throw new Error('repos.json has no repos list; left as it is for a person to repair');
  return data;
}

export function registerRepo(repoRoot, name, env = process.env) {
  const file = registryFile(env);
  withLock(file, () => {
    const data = registryForUpdate(env);
    const key = normPath(repoRoot);
    const hit = data.repos.find((r) => normPath(r.root) === key);
    const now = new Date().toISOString();
    if (hit) { hit.name = name; hit.lastSeen = now; } else data.repos.push({ root: repoRoot, name, lastSeen: now });
    writeJsonAtomic(file, data);
  });
}
