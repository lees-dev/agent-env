// 1Password CLI helpers shared by the agent lifecycle tools (~/.agents/bin).
// The service-account token is only ever placed in the op child's environment. It is never
// printed, logged, passed as an argument, or handed to any other child.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envGet, isWindows, run, which } from './proc.mjs';

/** Home directory as the given env sees it (tests point HOME/USERPROFILE at a fake home). */
export function homeDir(env = process.env) {
  return (isWindows ? envGet(env, 'USERPROFILE') : env.HOME) || os.homedir();
}

/**
 * Absolute path of the op binary, or null. PATH first; on Windows fall back to the WinGet
 * package folder and the WinGet links folder (a process started before op was installed has
 * a stale PATH).
 */
export function resolveOp(env = process.env) {
  const onPath = which('op', env);
  if (onPath) return onPath;
  if (!isWindows) return null;
  const local = envGet(env, 'LOCALAPPDATA');
  if (!local) return null;
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  let dirs = [];
  try {
    dirs = fs.readdirSync(pkgs).filter((d) => d.startsWith('AgileBits.1Password.CLI_')).sort();
  } catch { /* no WinGet packages folder */ }
  for (const d of dirs) {
    const p = path.join(pkgs, d, 'op.exe');
    if (fs.existsSync(p)) return p;
  }
  const link = path.join(local, 'Microsoft', 'WinGet', 'Links', 'op.exe');
  return fs.existsSync(link) ? link : null;
}

/** Value of OP_SERVICE_ACCOUNT_TOKEN from `reg query` output, or null. */
export function parseRegQuery(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(/^\s*OP_SERVICE_ACCOUNT_TOKEN\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/i);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * The Unix token file, read only when it is a regular file owned by this user with mode
 * 0600 (the same rule as scripts/lib/load-token.sh). Returns null otherwise.
 */
function readTokenFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
  if ((st.mode & 0o777) !== 0o600) return null;
  const v = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return v || null;
}

// Kept private to this module: no export returns the token. A hook or setup step runs as the
// same user and could read the persisted token itself; the tools only guarantee that they
// never hand it over (docs/lifecycle.md).
let captured = null;
let cached;

/**
 * Move OP_SERVICE_ACCOUNT_TOKEN out of process.env into this module, so nothing but the op
 * child process ever sees it: repo setup commands, hooks, gates
 * and every other child inherit an environment without it. Call once at startup.
 */
export function captureToken() {
  cached = undefined;
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase() !== 'OP_SERVICE_ACCOUNT_TOKEN') continue;
    if (process.env[k]) captured = process.env[k];
    delete process.env[k];
  }
}

/** Copy of env without OP_SERVICE_ACCOUNT_TOKEN (for every child that is not op). */
export function stripToken(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'OP_SERVICE_ACCOUNT_TOKEN') delete out[k];
  return out;
}

/**
 * The service-account token, or null: a captured or process-env token first; then the
 * Windows user environment (HKCU\Environment) or the Unix token file. Test mode
 * (AGENT_ENV_NO_SECRETS=1) only ever uses the process env.
 */
function readToken(env = process.env) {
  if (env === process.env) {
    if (cached === undefined) cached = captured || lookupToken(env);
    return cached;
  }
  return lookupToken(env);
}

function lookupToken(env) {
  const own = envGet(env, 'OP_SERVICE_ACCOUNT_TOKEN');
  if (own) return own;
  if (envGet(env, 'AGENT_ENV_NO_SECRETS') === '1') return null;
  if (isWindows) {
    const reg = path.join(envGet(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'reg.exe');
    const r = run(reg, ['query', 'HKCU\\Environment', '/v', 'OP_SERVICE_ACCOUNT_TOKEN'], { env });
    return r.status === 0 ? parseRegQuery(r.stdout) : null;
  }
  return readTokenFile(path.join(homeDir(env), '.config', 'op', 'agent-env-token'));
}

/** env plus OP_SERVICE_ACCOUNT_TOKEN when one can be found (only ever given to op). */
function opEnv(env = process.env) {
  const token = readToken(env);
  const out = stripToken(env);
  if (token) out.OP_SERVICE_ACCOUNT_TOKEN = token;
  return out;
}

/** {op, hasToken}: what is available, without revealing anything. */
export function opStatus(env = process.env) {
  return { op: resolveOp(env), hasToken: Boolean(readToken(env)) };
}

/**
 * Run op with explicit stdin (opts.input or 'ignore') and shell: false. Returns
 * {status, stdout, stderr}; status 127 when op is not installed. Callers must not print
 * stdout of commands that return secret values.
 */
export function runOp(args, opts = {}) {
  const env = opts.env || process.env;
  const op = resolveOp(env);
  if (!op) return { status: 127, stdout: '', stderr: 'op: not found', missing: true };
  const childEnv = opEnv(env);
  const r = run(op, args, { cwd: opts.cwd, env: childEnv, input: opts.input });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
