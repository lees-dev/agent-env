// Runs one function of a repo's .agents/hooks.mjs in its own node process, so hook code never
// shares a process (or an environment) with the 1Password token. agent-worktree.mjs starts it
// with OP_SERVICE_ACCOUNT_TOKEN stripped and the context as JSON on stdin.
// Exit codes: 0 ok, 1 the hook threw. A missing function is reported by writing "absent" to
// the result file the engine names (exit codes alone are ambiguous: a hook may exit 3 itself).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { addResource, normalizeTrack, removeResource, updateLedger } from './ledger.mjs';
import { stripToken } from './op.mjs';
import { run, splitArgv } from './proc.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { hookFile, fn, ctx: data, commonDir, resultFile } = input;
const say = (msg) => process.stderr.write(`agent-worktree: [hook] ${msg}\n`);

const mod = await import(pathToFileURL(hookFile).href);
if (typeof mod[fn] !== 'function') {
  if (resultFile) fs.writeFileSync(resultFile, 'absent');
  process.exit(0);
}

const perWorktree = fn !== 'sweep' && data.wtId;
const ctx = {
  ...data,
  track(kind, id, where) {
    if (!perWorktree) throw new Error('track is per worktree; not available in sweep');
    const value = normalizeTrack(kind, id, data.worktreePath);
    if (data.dryRun) return say(`would track ${kind} ${value}`);
    updateLedger(commonDir, data.wtId, (l) => addResource(l, kind, value, where));
  },
  untrack(kind, id) {
    if (!perWorktree) throw new Error('untrack is per worktree; not available in sweep');
    const value = normalizeTrack(kind, id, data.worktreePath);
    if (data.dryRun) return say(`would untrack ${kind} ${value}`);
    updateLedger(commonDir, data.wtId, (l) => removeResource(l, kind, value));
  },
  log(msg) { say(msg); },
  run(argv, o = {}) {
    const a = splitArgv(argv);
    if (data.dryRun && !o.readOnly) {
      say(`would run: ${a[0]} (${a.length - 1} args)`);
      return { status: 0, stdout: '', stderr: '', dryRun: true };
    }
    const cwd = o.cwd || (data.worktreeGone ? data.repoRoot : data.worktreePath);
    return run(a[0], a.slice(1), { cwd, env: stripToken(o.env || process.env), input: o.input, inherit: o.inherit });
  },
};

try {
  await mod[fn](ctx);
} catch (e) {
  process.stderr.write(`agent-worktree: hooks.${fn} failed: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
