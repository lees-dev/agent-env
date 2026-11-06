// Find and stop processes that run inside a worktree (~/.agents/bin).
// Windows: CIM (command line and executable path; Windows does not expose another process's
// cwd). Linux: /proc (cwd, exe, command line). macOS and other Unix: ps plus lsof for cwd.
// Never matches this process, its ancestors, JetBrains IDE processes or T3 Code itself.
import fs from 'node:fs';
import path from 'node:path';
import { envGet, isWindows, run, sleepMs } from './proc.mjs';
import { isUnder } from './repo.mjs';

const PROTECTED = [
  /jetbrains/i, /toolbox/i, /fsnotifier/i,
  /(^|[\\/])(idea|idea64|webstorm|webstorm64|pycharm|pycharm64|goland|goland64|rider|rider64|clion|clion64|datagrip|datagrip64|rubymine|rubymine64|phpstorm|phpstorm64|rustrover|rustrover64|fleet)(\.exe|\.sh)?$/i,
  /(^|[\\/])t3( code)?(\.exe)?$/i, /t3-?code/i, /[\\/]\.t3[\\/](?!worktrees[\\/])/i,
];

/** [{pid, ppid, name, exe, cmd, cwd}] for every visible process (best effort). */
export function listProcesses(env = process.env) {
  if (isWindows) return listWindows(env);
  if (fs.existsSync('/proc/self/stat')) return listProc();
  return listPs(env);
}

function listWindows(env) {
  const root = envGet(env, 'SystemRoot') || 'C:\\Windows';
  const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const r = run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  if (r.status !== 0) return [];
  let rows;
  try { rows = JSON.parse(r.stdout || '[]'); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map((x) => ({
    pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name || '',
    exe: x.ExecutablePath || '', cmd: x.CommandLine || '', cwd: '',
  }));
}

function listProc() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const p = { pid: Number(d), ppid: 0, name: '', exe: '', cmd: '', cwd: '' };
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      p.name = stat.slice(stat.indexOf('(') + 1, close);
      p.ppid = Number(stat.slice(close + 2).split(' ')[1]);
    } catch { continue; }
    try { p.cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* gone */ }
    try { p.cwd = fs.readlinkSync(`/proc/${d}/cwd`); } catch { /* not ours */ }
    try { p.exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { /* not ours */ }
    out.push(p);
  }
  return out;
}

function listPs(env) {
  const r = run('ps', ['-axww', '-o', 'pid=,ppid=,command='], { env });
  if (r.status !== 0) return [];
  const procs = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3].split(' ')[0]), exe: '', cmd: m[3], cwd: '' });
  }
  const l = run('lsof', ['-a', '-d', 'cwd', '-Fpn'], { env });
  if (l.status === 0 || l.stdout) {
    let pid = null;
    for (const line of l.stdout.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && procs.has(pid)) procs.get(pid).cwd = line.slice(1);
    }
  }
  return [...procs.values()];
}

/** True when text mentions dir as a whole path (not as the prefix of a longer name). */
export function mentionsPath(text, dir) {
  if (!text) return false;
  const norm = (s) => (isWindows ? s.replace(/\//g, '\\').toLowerCase() : s);
  const hay = norm(text);
  const needle = norm(path.resolve(dir)).replace(/[\\/]+$/, '');
  let i = hay.indexOf(needle);
  while (i >= 0) {
    const next = hay[i + needle.length];
    if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
}

function ancestors(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set([pid]);
  let cur = byPid.get(pid);
  // The parent of this process may not be in the list (Windows CIM lists it; /proc does too).
  let ppid = cur ? cur.ppid : process.ppid;
  while (ppid && !seen.has(ppid)) {
    seen.add(ppid);
    cur = byPid.get(ppid);
    ppid = cur ? cur.ppid : 0;
  }
  return seen;
}

/** Processes whose cwd, executable or command line is under dir. */
export function processesUnder(dir, procs = listProcesses()) {
  const skip = ancestors(procs, process.pid);
  return procs.filter((p) => {
    if (!p.pid || skip.has(p.pid)) return false;
    if (PROTECTED.some((re) => re.test(p.exe) || re.test(p.name))) return false;
    return (p.cwd && isUnder(p.cwd, dir)) || (p.exe && isUnder(p.exe, dir)) || mentionsPath(p.cmd, dir);
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Stop the given processes (TERM, then KILL after a grace period). Returns {stopped, failed}. */
export function stopProcesses(list, graceMs = 3000) {
  for (const p of list) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
  const until = Date.now() + graceMs;
  let left = list.filter((p) => alive(p.pid));
  while (left.length && Date.now() < until) {
    sleepMs(100);
    left = left.filter((p) => alive(p.pid));
  }
  for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  sleepMs(left.length ? 300 : 0);
  const failed = list.filter((p) => alive(p.pid)).length;
  return { stopped: list.length - failed, failed };
}
