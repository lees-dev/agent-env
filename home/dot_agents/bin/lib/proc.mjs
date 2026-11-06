// Process helpers shared by the agent lifecycle tools (~/.agents/bin).
// Every child runs with shell: false. On Windows a .cmd/.bat target is started through
// cmd.exe with each argument escaped (the cross-spawn rules), because Node refuses to run
// batch files directly. Output from these helpers is never logged by them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** PATH value of an env object (Windows env keys are case-insensitive). */
export function envPath(env = process.env) {
  if (!isWindows) return env.PATH || '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] || '' : '';
}

/** Copy of env with PATH replaced (keeps the original key spelling on Windows). */
export function withPath(env, value) {
  const out = { ...env };
  if (isWindows) {
    for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k];
    out.Path = value;
  } else out.PATH = value;
  return out;
}

/** Look up a variable case-insensitively on Windows. */
export function envGet(env, name) {
  if (!isWindows) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Absolute path of an executable, or null. On Windows tries PATHEXT (.EXE first, then .CMD,
 * .BAT, .COM) and never returns an extension-less file, which Windows cannot run.
 */
export function which(cmd, env = process.env) {
  if (!cmd) return null;
  const exts = isWindows
    ? ['.exe', '.cmd', '.bat', '.com'].concat(
        String(envGet(env, 'PATHEXT') || '').toLowerCase().split(';').filter(Boolean))
    : [''];
  const uniq = [...new Set(exts)];
  const hasDir = cmd.includes('/') || (isWindows && cmd.includes('\\'));
  const candidates = (base) => {
    if (!isWindows) return [base];
    const ext = path.extname(base).toLowerCase();
    if (ext && uniq.includes(ext)) return [base];
    return uniq.map((e) => base + e);
  };
  if (hasDir || path.isAbsolute(cmd)) {
    for (const c of candidates(path.resolve(cmd))) {
      if (isFile(c) && (isWindows || isExecutable(c))) return c;
    }
    return null;
  }
  for (const dir of envPath(env).split(path.delimiter)) {
    if (!dir) continue;
    const d = dir.replace(/^"(.*)"$/, '$1');
    for (const c of candidates(path.join(d, cmd))) {
      if (isFile(c) && (isWindows || isExecutable(c))) return c;
    }
  }
  return null;
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// cross-spawn's cmd.exe escaping (MIT): metacharacters get a caret; batch shims that pass %*
// on to another program parse the line twice, so their arguments are escaped twice.
const META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCommand(s) { return s.replace(META, '^$1'); }
function escapeArgument(arg, twice) {
  let a = String(arg);
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  if (twice) a = a.replace(META, '^$1');
  return a;
}

/**
 * Resolve cmd and build the [file, args, options] triple for spawn/spawnSync. Throws an
 * Error with code 'ENOENT' when the command is not found.
 */
export function prepare(cmd, args = [], opts = {}) {
  const env = opts.env || process.env;
  const file = which(cmd, env);
  if (!file) {
    const e = new Error(`${cmd}: not found on PATH`);
    e.code = 'ENOENT';
    throw e;
  }
  const options = { ...opts, env, shell: false, windowsHide: true };
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [escapeCommand(file), ...args.map((a) => escapeArgument(a, true))].join(' ');
    const comspec = envGet(env, 'ComSpec') || 'cmd.exe';
    return [comspec, ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }];
  }
  return [file, args.map(String), options];
}

/**
 * Run a command synchronously. Returns {status, stdout, stderr, error}. stdin is 'ignore'
 * unless opts.input is given (then a pipe carrying it). opts.inherit streams output to the
 * caller's terminal instead of capturing it (opts.stdoutToStderr sends that stdout to stderr,
 * so machine-readable output on our own stdout stays clean).
 */
export function run(cmd, args = [], opts = {}) {
  const { input, inherit, stdoutToStderr, ...rest } = opts;
  let prepared;
  try {
    prepared = prepare(cmd, args, rest);
  } catch (error) {
    return { status: 127, stdout: '', stderr: '', error };
  }
  const [file, argv, options] = prepared;
  const stdin = input === undefined ? 'ignore' : 'pipe';
  const r = spawnSync(file, argv, {
    ...options,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? [stdin, stdoutToStderr ? 2 : 'inherit', 'inherit'] : [stdin, 'pipe', 'pipe'],
  });
  return {
    status: r.status === null ? (r.error ? 127 : 128) : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

/** Start a detached background process (stdio ignored) and forget it. */
export function spawnDetached(cmd, args = [], opts = {}) {
  const [file, argv, options] = prepare(cmd, args, opts);
  const child = spawn(file, argv, { ...options, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

export function git(args, opts = {}) { return run('git', args, opts); }
export function gh(args, opts = {}) { return run('gh', args, opts); }

/** git output, trimmed; null on failure. */
export function gitOut(args, opts = {}) {
  const r = git(args, opts);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** gh output parsed as JSON; throws with a short reason on failure. */
export function ghJson(args, opts = {}) {
  const r = gh(args, opts);
  if (r.status !== 0) {
    const e = new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
    e.status = r.status;
    e.stderr = r.stderr;
    throw e;
  }
  try {
    return JSON.parse(r.stdout || 'null');
  } catch {
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: output is not JSON`);
  }
}

/**
 * Split a command string into argv without a shell. Supports '...' (literal) and "..."
 * (with \" and \\ escapes) quoting. Unquoted shell operators are rejected: a repo that needs
 * them points at a script instead.
 */
export function splitArgv(str) {
  if (Array.isArray(str)) return str.map(String);
  const s = String(str);
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new Error(`unterminated ' in: ${s}`);
      cur += s.slice(i + 1, j);
      has = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && (s[j + 1] === '"' || s[j + 1] === '\\')) j++;
        cur += s[j];
      }
      if (j >= s.length) throw new Error(`unterminated " in: ${s}`);
      has = true;
      i = j;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if ('|&;<>`$()'.includes(c) && !(c === '$' && !/[({A-Za-z_]/.test(s[i + 1] || ''))) {
      throw new Error(`shell syntax is not supported (found ${c}); point the command at a script: ${s}`);
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  if (!out.length) throw new Error('empty command');
  return out;
}

/** Synchronous sleep without spinning. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
