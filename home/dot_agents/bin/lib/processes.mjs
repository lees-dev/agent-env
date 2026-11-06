// Find and stop processes that run inside a worktree (~/.agents/bin).
// Windows: CIM (command line and executable path; Windows does not expose another process's
// cwd). Linux: /proc (cwd, exe, argv). macOS and other Unix: ps plus lsof for cwd.
// A process matches when its cwd or executable is inside the directory, when one of its
// arguments is an absolute path inside it, or when it descends from a matching process.
// Never matches this process, its ancestors, the lifecycle tools, JetBrains IDEs or T3 Code.
import fs from 'node:fs';
import path from 'node:path';
import { envGet, isWindows, run, sleepMs } from './proc.mjs';
import { canonical, isUnder } from './repo.mjs';

const PROTECTED = [
  /jetbrains/i, /toolbox/i, /fsnotifier/i,
  /(^|[\\/])(idea|idea64|webstorm|webstorm64|pycharm|pycharm64|goland|goland64|rider|rider64|clion|clion64|datagrip|datagrip64|rubymine|rubymine64|phpstorm|phpstorm64|rustrover|rustrover64|fleet)(\.exe|\.sh)?$/i,
  /(^|[\\/])t3( code)?(\.exe)?$/i, /t3-?code/i, /[\\/]\.t3[\\/](?!worktrees[\\/])/i,
];
const OWN_TOOLS = /(^|[\\/\s"'])(agent-worktree|agent-secret|hook-runner)\.mjs/i;

/**
 * [{pid, ppid, name, exe, cmd, args, cwd, start}] for every visible process, or null when the
 * listing failed (the caller must then treat the worktree as in use).
 */
export function listProcesses(env = process.env) {
  if (envGet(env, 'AGENT_ENV_NO_SECRETS') === '1' && envGet(env, 'AGENT_WORKTREE_TEST_PROCLIST_FAIL') === '1') return null;
  try {
    if (isWindows) return listWindows(env);
    if (fs.existsSync('/proc/self/stat')) return listProc();
    return listPs(env);
  } catch {
    return null;
  }
}

function listWindows(env) {
  const root = envGet(env, 'SystemRoot') || 'C:\\Windows';
  const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,'
      + '@{n=\'Start\';e={ if ($_.CreationDate) { $_.CreationDate.ToString(\'o\') } else { \'\' } }} | ConvertTo-Json -Compress',
  ].join('; ');
  const r = run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map((x) => ({
    pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name || '', exe: x.ExecutablePath || '',
    cmd: x.CommandLine || '', args: splitWindowsArgs(x.CommandLine || ''), cwd: '', start: x.Start || '',
  }));
}

function listProc() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const p = { pid: Number(d), ppid: 0, name: '', exe: '', cmd: '', args: [], cwd: '', start: '' };
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      p.name = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      p.ppid = Number(f[1]);
      p.start = f[19] || '';
    } catch { continue; }
    try { p.args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean); p.cmd = p.args.join(' '); } catch { /* gone */ }
    try { p.cwd = fs.readlinkSync(`/proc/${d}/cwd`); } catch { /* not ours */ }
    try { p.exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { /* not ours */ }
    out.push(p);
  }
  return out;
}

function listPs(env) {
  const r = run('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command='], { env });
  if (r.status !== 0) return null;
  const procs = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (!m) continue;
    // ps loses argument boundaries: keep the whole command as one "argument" and match a
    // path only when it is followed by a separator or the end (see pathArgUnder).
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: m[3], name: path.basename(m[4].split(' ')[0]), exe: '', cmd: m[4], args: [], cwd: '', psOnly: true });
  }
  const l = run('lsof', ['-a', '-d', 'cwd', '-Fpn'], { env });
  let pid = null;
  for (const line of (l.stdout || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && procs.has(pid)) procs.get(pid).cwd = line.slice(1);
  }
  return [...procs.values()];
}

/** Split a Windows command line the way CommandLineToArgvW does. */
export function splitWindowsArgs(cmd) {
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      let n = 0;
      while (cmd[i] === '\\') { n++; i++; }
      if (cmd[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2) { cur += '"'; has = true; } else i--;
      } else { cur += '\\'.repeat(n); i--; }
      has = true;
    } else if (c === '"') {
      if (quoted && cmd[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      has = true;
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

const isAbs = (s) => (isWindows ? /^([A-Za-z]:[\\/]|\\\\)/.test(s) : s.startsWith('/'));

/** True when one complete argument (or the value of --flag=value) is a path inside a dir. */
export function argsUnder(p, dirs) {
  if (p.psOnly) {
    // Whole command string: require a separator or the end after the directory.
    return dirs.some((d) => {
      const needle = d.replace(/[\\/]+$/, '');
      let i = p.cmd.indexOf(needle);
      while (i >= 0) {
        const next = p.cmd[i + needle.length];
        if (next === undefined || next === '/') return true;
        i = p.cmd.indexOf(needle, i + 1);
      }
      return false;
    });
  }
  for (const a of p.args || []) {
    for (const v of [a, a.includes('=') ? a.slice(a.indexOf('=') + 1) : null]) {
      if (v && isAbs(v) && dirs.some((d) => isUnder(v, d))) return true;
    }
  }
  return false;
}

function ancestors(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set([pid]);
  let ppid = byPid.has(pid) ? byPid.get(pid).ppid : process.ppid;
  while (ppid && !seen.has(ppid)) {
    seen.add(ppid);
    const cur = byPid.get(ppid);
    ppid = cur ? cur.ppid : 0;
  }
  return seen;
}

/** Processes inside dir (and their descendants), excluding this process tree and protected tools. */
export function processesUnder(dir, procs) {
  const dirs = [...new Set([path.resolve(dir), canonical(dir)])];
  const skip = ancestors(procs, process.pid);
  const excluded = (p) => skip.has(p.pid) || OWN_TOOLS.test(p.cmd)
    || PROTECTED.some((re) => re.test(p.exe) || re.test(p.name));
  const hit = new Map();
  for (const p of procs) {
    if (!p.pid || excluded(p)) continue;
    const inside = (p.cwd && dirs.some((d) => isUnder(p.cwd, d))) || (p.exe && dirs.some((d) => isUnder(p.exe, d))) || argsUnder(p, dirs);
    if (inside) hit.set(p.pid, p);
  }
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const queue = [...hit.values()];
  while (queue.length) {
    for (const c of children.get(queue.shift().pid) || []) {
      if (hit.has(c.pid) || excluded(c)) continue;
      hit.set(c.pid, c);
      queue.push(c);
    }
  }
  return [...hit.values()];
}

function zombie(pid) {
  if (isWindows) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch { /* no /proc */ }
  const r = run('ps', ['-o', 'stat=', '-p', String(pid)]);
  return r.status === 0 && r.stdout.trim().startsWith('Z');
}

/** Running (a zombie has exited and only waits for its parent to reap it). */
function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return !zombie(pid);
}

/**
 * Stop the given processes (TERM, then KILL after a grace period). Each pid is re-checked
 * first: a pid whose start time or command line changed was reused and is left alone.
 * Returns {stopped, failed, listFailed}.
 */
export function stopProcesses(list, env = process.env, graceMs = 3000) {
  if (!list.length) return { stopped: 0, failed: 0 };
  const now = listProcesses(env);
  if (!now) return { stopped: 0, failed: list.length, listFailed: true };
  const byPid = new Map(now.map((p) => [p.pid, p]));
  const targets = list.filter((p) => {
    const q = byPid.get(p.pid);
    return q && q.start === p.start && q.cmd === p.cmd;
  });
  for (const p of targets) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
  const until = Date.now() + graceMs;
  let left = targets.filter((p) => alive(p.pid));
  while (left.length && Date.now() < until) {
    sleepMs(100);
    left = left.filter((p) => alive(p.pid));
  }
  for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  if (left.length) sleepMs(300);
  const failed = targets.filter((p) => alive(p.pid)).length;
  return { stopped: targets.length - failed, failed };
}
