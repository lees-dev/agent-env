// land-queue: the per-repo lander. Lands `queued` PRs one at a time, serially per repo.
// The rules: pr-workflow skill, section 4.
//
// Usage:
//   node land-queue.mjs run     [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]
//   node land-queue.mjs status  [--repo owner/name] [--root <checkout>] [--all] [--json]
//   node land-queue.mjs unpause [--repo owner/name] [--root <checkout>] [--json]
//
// Repos: --root (default: the current checkout); --all reads ~/.agents/state/repos.json.
// Each round: stop if the repo is paused (repo variable AGENT_LANDING_PAUSED=1); admit the oldest
// `queue-waiting` PRs while queued + landing < maxQueued; take the landing lock; reset any leftover
// `landing` label (a crashed run) to `queued`; land the first PR in order (queue-next,
// Linear-Priority 1..4 with 0/missing = 3, time queued, number):
//   head == gated sha -> rebase in <main checkout>-lander -> unchanged? -> setup + affectedGate
//   (one retry) -> re-check -> push --force-with-lease -> re-check -> final base check -> merge
//   pinned -> release.
// "Unchanged" = no conflict, every commit `=` in `git range-diff <old base>..<gated>
// <new base>..<rebased>`, and the rebased diff touches no path the gated diff did not.
// The re-checks re-read the PR's labels and head and the pause flag right before the push and
// right before the merge: queue-hold or a pause aborts without a merge (the PR goes back to
// `queued`, keeping queue-hold), a changed head bounces. The final base check refetches the base
// immediately before the merge; if it moved, the rebase and validation run again (at most 3
// times, then a bounce). An error mid-landing also puts the PR back to `queued`: `landing` is
// never left behind. Anything else that fails bounces the PR: queued/landing -> queue-blocked,
// one comment with the reason, and a `Bounced:` line in its `## Landing` section. The third bounce
// (after two automatic fix attempts) parks it: the comment starts with `PARKED:`.
// A red wide sweep (every sweepEveryMerges merges) sets AGENT_LANDING_PAUSED=1; `unpause` reruns
// the sweep on the base and clears the flag only when it is green.
// A stale lock (older than its ttl) is reported, and reclaimed only with --reclaim-stale.
// Output (--json): one report per repo
//   {repo, merged:[{pr,sha,mergeSha,rebased}], bounced:[{pr,reason,attempt,parked}], admitted:[n],
//    aborted:[{pr,reason}], reset:[n], queued, held:[n], waiting:[{pr,dependsOn}], queueWaiting:[n],
//    stale:[{host,pid,ageMin}], busy, paused, alerts:[...], sweep}
// Exit: 0 when every repo was processed (bounces included), 1 on an error, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import {
  BOUNCE_MARKER, Gh, LandError, LandingLock,
  appendLanding, childEnv, baseTreeOf, bumpMergeCount, classifyQueue, fetchBranch, firstLine, git, gitOk,
  isAncestor, isStale, labelNames, listQueue, listWaiting, loadRepoConfig, mainCheckout, markSwept, mergePinned, parseArgs,
  parseLanding, print, rangeDiffChanges, registeredRepos, repoTop, runAsync, scrub, setLabels, slugFromRemote, splitArgv, waitForPr,
} from './lib/land.mjs';

const USAGE = 'usage: node land-queue.mjs <run|status|unpause> [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]';
const MAX_PRS_PER_RUN = 50;
const MAX_BASE_RETRIES = 3;
const MAX_AUTO_FIXES = 2;

// ---------------------------------------------------------------- lander checkout

// <main checkout>-lander: a detached worktree created once and locked, so a sweep's plain
// `git worktree remove` (no --force) and `git worktree prune` both leave it alone.
function landerCheckout(mainRoot, base) {
  const dir = `${mainRoot}-lander`;
  if (!fs.existsSync(dir)) {
    gitOk(['worktree', 'add', '--detach', dir, `refs/remotes/origin/${base}`], { cwd: mainRoot });
    gitOk(['worktree', 'lock', '--reason', 'land-queue lander checkout', dir], { cwd: mainRoot });
  } else if (git(['rev-parse', '--git-dir'], { cwd: dir }).status !== 0) {
    throw new LandError(`${dir} exists but is not a git checkout`);
  }
  // Leave any earlier half-finished rebase.
  if (fs.existsSync(path.join(gitOk(['rev-parse', '--absolute-git-dir'], { cwd: dir }), 'rebase-merge'))) git(['rebase', '--abort'], { cwd: dir });
  return dir;
}

function resetTo(dir, ref) {
  gitOk(['checkout', '--quiet', '--detach', '--force', ref], { cwd: dir });
  gitOk(['clean', '-fdq'], { cwd: dir });
}

function changedPaths(dir, from, to) {
  return new Set(gitOk(['diff', '--name-only', '--no-renames', from, to], { cwd: dir }).split(/\r?\n/).filter(Boolean));
}

// Repo commands never see the 1Password service-account token.
const commandEnv = () => childEnv({ AGENT_LANDER: '1' });

async function runCommands(cmds, dir, lock, ttlMin) {
  const tickMs = Math.max(60000, Math.floor((ttlMin * 60000) / 3));
  for (const c of cmds) {
    const r = await runAsync(splitArgv(c), { cwd: dir, env: commandEnv(), tickMs, onTick: () => lock?.refresh() });
    if (r.status !== 0) return { ok: false, cmd: c, status: r.status, tail: r.tail };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- bounce

function bounce(gh, pr, reason, tail = []) {
  const at = new Date().toISOString();
  const attempt = parseLanding(pr.body).bounces.length + 1;
  const body = appendLanding(pr.body, `Bounced: ${at} ${reason}`);
  gh.prEdit(pr.number, { body });
  pr.body = body;
  setLabels(gh, pr, { add: ['queue-blocked'], remove: ['queued', 'landing', 'queue-waiting'] });
  // Two automatic fix attempts (after bounces 1 and 2); the third bounce parks it for the owner.
  const parked = attempt > MAX_AUTO_FIXES;
  const lines = parked
    ? [
      `PARKED: the land queue bounced this PR ${attempt} times; the last reason: ${scrub(reason)}`,
      '',
      `No more automatic fixes (${MAX_AUTO_FIXES} attempts used). The owner or \`full-send\` decides the next step; after a fix, re-gate, re-review and run \`land-pr <n> --sha <new head>\`.`,
    ]
    : [
      `**Land queue bounced this PR** (attempt ${attempt} of ${MAX_AUTO_FIXES} automatic fixes): ${scrub(reason)}`,
      '',
      'Fix it on the branch, run the gate and the review on the new head, then run `land-pr <n> --sha <new head>` again.',
    ];
  const t = tail.map(scrub).filter((l) => l.trim()).slice(-20);
  if (t.length) lines.push('', `Last ${t.length} lines of output:`, '', '```text', ...t.map((l) => l.replace(/```/g, "'''")), '```');
  lines.push('', BOUNCE_MARKER);
  gh.prComment(pr.number, `${lines.join('\n')}\n`);
  return { pr: pr.number, reason: scrub(reason), attempt, parked };
}

// ---------------------------------------------------------------- one PR

// Re-read the PR and the pause flag. Returns null when landing may continue.
function recheck(gh, pr, expectHead) {
  const p = gh.prView(pr.number);
  if (p.state !== 'OPEN') return { stop: `PR is ${p.state}` };
  pr.labels = p.labels;
  pr.body = p.body;
  if (labelNames(p).includes('queue-hold')) return { hold: 'queue-hold appeared' };
  if (gh.isPaused()) return { hold: 'repo paused', paused: true };
  if (p.headRefOid !== expectHead) return { headChanged: p.headRefOid };
  return null;
}

// Handle a failed re-check: queue-hold or pause -> back to queued, no merge; head -> bounce.
function onRecheck(gh, pr, r, stage) {
  if (r.stop) {
    setLabels(gh, pr, { remove: ['landing'] });
    return { aborted: { pr: pr.number, reason: `${r.stop} before ${stage}` } };
  }
  if (r.hold) {
    setLabels(gh, pr, { add: ['queued'], remove: ['landing'] });
    return { aborted: { pr: pr.number, reason: `${r.hold} before ${stage}` }, paused: Boolean(r.paused) };
  }
  return { bounced: bounce(gh, pr, `head changed while landing (now ${r.headChanged.slice(0, 12)}, before ${stage})`) };
}

async function landOne(ctx, pr) {
  const { gh, cfg, mainRoot, lock } = ctx;
  setLabels(gh, pr, { add: ['landing'], remove: ['queued'] });
  const gated = parseLanding(pr.body).gatedSha;
  if (!gated) return { bounced: bounce(gh, pr, 'no `Gate: pass @ <sha>` line in the ## Landing section') };
  if (!pr.headRefOid.startsWith(gated)) {
    return { bounced: bounce(gh, pr, `head changed after the gate (head ${pr.headRefOid.slice(0, 12)}, gated ${gated.slice(0, 12)})`) };
  }
  const head = pr.headRefOid;
  const base = pr.baseRefName || cfg.base;
  const dir = landerCheckout(mainRoot, base);
  fetchBranch(dir, base);
  const f = git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`], { cwd: dir });
  if (f.status !== 0) return { bounced: bounce(gh, pr, `cannot fetch ${pr.headRefName} from origin (fork PRs are not supported)`) };
  const fetched = gitOk(['rev-parse', '--verify', `refs/remotes/origin/${pr.headRefName}^{commit}`], { cwd: dir });
  if (fetched !== head) return { bounced: bounce(gh, pr, `branch moved while landing (origin has ${fetched.slice(0, 12)})`) };

  const baseRef = `refs/remotes/origin/${base}`;
  let landSha = head;
  let rebased = false;
  if (!isAncestor(baseRef, head, dir)) {
    rebased = true;
    const forkPoint = gitOk(['merge-base', baseRef, head], { cwd: dir });
    const newBase = gitOk(['rev-parse', baseRef], { cwd: dir });
    resetTo(dir, head);
    const rb = git(['-c', 'rebase.autoSquash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', newBase], {
      cwd: dir, env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    if (rb.status !== 0) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split(/\r?\n/).filter(Boolean);
      git(['rebase', '--abort'], { cwd: dir });
      resetTo(dir, baseRef);
      const list = files.slice(0, 10).join(', ');
      return { bounced: bounce(gh, pr, `rebase onto ${base} conflicts in ${files.length} file(s)${list ? `: ${list}` : ''}; re-gate and re-review after resolving`) };
    }
    const rebasedSha = gitOk(['rev-parse', 'HEAD'], { cwd: dir });
    const rd = git(['range-diff', '--no-color', `${forkPoint}..${head}`, `${newBase}..${rebasedSha}`], { cwd: dir });
    if (rd.status !== 0) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `git range-diff failed: ${firstLine(rd.stderr)}`) };
    }
    const changes = rangeDiffChanges(rd.stdout);
    if (changes.total === 0 || changes.changed.length) {
      resetTo(dir, baseRef);
      const what = changes.total === 0 ? 'the rebase left no commits' : `the rebase changed ${changes.changed.length} of ${changes.total} commit(s)`;
      return { bounced: bounce(gh, pr, `${what}; re-gate and re-review`, changes.changed) };
    }
    const before = changedPaths(dir, forkPoint, head);
    const added = [...changedPaths(dir, newBase, rebasedSha)].filter((p) => !before.has(p));
    if (added.length) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `the rebased diff touches ${added.length} new path(s): ${added.slice(0, 10).join(', ')}; re-gate and re-review`) };
    }
    // Same patches on a newer base: rerun the affected gate only.
    let g = await runCommands([...cfg.setup, ...cfg.affectedGate], dir, lock, cfg.lockTtlMin);
    if (!g.ok) g = await runCommands(cfg.affectedGate, dir, lock, cfg.lockTtlMin);
    if (!g.ok) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `affected gate failed after the rebase (\`${g.cmd}\` exit ${g.status}, retried once)`, g.tail) };
    }
    landSha = rebasedSha;
    const pre = recheck(gh, pr, head);
    if (pre) { resetTo(dir, baseRef); return onRecheck(gh, pr, pre, 'the push'); }
    const push = git(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, 'origin', `${landSha}:refs/heads/${pr.headRefName}`], { cwd: dir });
    resetTo(dir, baseRef);
    if (push.status !== 0) return { bounced: bounce(gh, pr, `push of the rebased head was rejected: ${firstLine(push.stderr || push.stdout)}`) };
    const body = appendLanding(pr.body, `Gate: pass @ ${landSha} (lander rebase)`);
    gh.prEdit(pr.number, { body });
    pr.body = body;
    const seen = waitForPr(gh, pr.number, (p) => p.headRefOid === landSha);
    if (seen.headRefOid !== landSha) return { retry: true, note: 'GitHub has not seen the pushed head yet' };
  }

  // Right before the merge: nothing held, paused or pushed; then the final base check (a moved
  // base means the caller redoes the rebase and validation).
  const pre = recheck(gh, pr, landSha);
  if (pre) return onRecheck(gh, pr, pre, 'the merge');
  fetchBranch(dir, base);
  if (!isAncestor(baseRef, landSha, dir)) return { retry: true, note: `${base} moved during the landing` };
  const m = mergePinned(gh, cfg, { pr: pr.number, sha: landSha });
  if (!m.ok) return { bounced: bounce(gh, pr, `merge failed: ${m.message}`) };
  return { merged: { pr: pr.number, sha: landSha, mergeSha: m.mergeSha, rebased } };
}

// ---------------------------------------------------------------- capacity

// Move the oldest queue-waiting PRs to queued while queued + landing < maxQueued.
function admitWaiting(ctx, report) {
  const { gh, cfg } = ctx;
  let free = cfg.maxQueued - listQueue(gh).length;
  if (free <= 0) return;
  for (const w of listWaiting(gh)) {
    if (free <= 0) break;
    if (labelNames(w).includes('queue-hold')) continue;
    const gated = parseLanding(w.body).gatedSha;
    if (!gated || !w.headRefOid.startsWith(gated)) {
      report.bounced.push(bounce(gh, w, 'head changed while waiting for queue capacity'));
      continue;
    }
    setLabels(gh, w, { add: ['queued'], remove: ['queue-waiting'] });
    report.admitted.push(w.number);
    free--;
  }
}

// ---------------------------------------------------------------- wide sweep

async function runSweep(ctx, base) {
  const { cfg, mainRoot, lock } = ctx;
  const dir = landerCheckout(mainRoot, base);
  fetchBranch(dir, base);
  resetTo(dir, `refs/remotes/origin/${base}`);
  const cmds = Array.isArray(cfg.wideSweep) ? cfg.wideSweep : [cfg.wideSweep];
  return runCommands([...cfg.setup, ...cmds], dir, lock, cfg.lockTtlMin);
}

async function wideSweep(ctx, report, base) {
  const { gh, cfg } = ctx;
  const count = bumpMergeCount(gh.repo);
  if (!cfg.wideSweep || count.sinceSweep < cfg.sweepEveryMerges) return;
  markSwept(gh.repo);
  const r = await runSweep(ctx, base);
  report.sweep = { ran: true, ok: r.ok, afterMerges: count.sinceSweep };
  if (r.ok) return;
  gh.setPaused(true);
  report.paused = true;
  report.alerts.push(`wide sweep on ${base} failed after ${count.sinceSweep} merges (\`${r.cmd}\` exit ${r.status}); the repo is paused (AGENT_LANDING_PAUSED=1). File a ticket, fix ${base}, then run land-queue unpause.`);
}

// ---------------------------------------------------------------- per repo

function target(root, slug) {
  const repo = slug || slugFromRemote(root);
  if (!repo) throw new LandError(`cannot tell the GitHub repo of ${root}; pass --repo owner/name`, 2);
  return { root, repo };
}

function context(t) {
  const cfg = loadRepoConfig(t.root);
  const gh = new Gh({ repo: t.repo });
  return { gh, cfg, root: t.root, mainRoot: mainCheckout(t.root), lock: new LandingLock(gh, { ttlMin: cfg.lockTtlMin }) };
}

function fillQueueState(gh, report) {
  const q = classifyQueue(gh, listQueue(gh));
  report.queued = q.eligible.length + q.waiting.length;
  report.held = q.held;
  report.waiting = q.waiting;
  report.queueWaiting = listWaiting(gh).map((p) => p.number);
  return q;
}

async function runRepo(t, opts) {
  const ctx = context(t);
  const { gh, cfg } = ctx;
  const report = {
    repo: t.repo, merged: [], bounced: [], admitted: [], aborted: [], reset: [], queued: 0, held: [], waiting: [], queueWaiting: [],
    stale: [], busy: false, paused: false, alerts: [], sweep: null,
  };
  if (!opts.dryRun) gh.ensureLabels();
  for (let i = 0; i < MAX_PRS_PER_RUN; i++) {
    if (gh.isPaused()) { report.paused = true; break; }
    if (!opts.dryRun) admitWaiting(ctx, report);
    let q = fillQueueState(gh, report);
    if (!q.eligible.length) break;
    if (opts.dryRun) { report.plan = q.eligible.map((p) => p.number); break; }

    fetchBranch(ctx.root, cfg.base);
    const got = ctx.lock.acquire(baseTreeOf(ctx.root, `refs/remotes/origin/${cfg.base}`));
    if (!got.held) {
      const h = got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null;
      if (got.stale && opts.reclaimStale && ctx.lock.reclaim(got.holder)) {
        report.alerts.push(`reclaimed a stale landing lock (${h?.ageMin} min old)`);
      } else {
        if (got.stale) report.stale.push(h); else report.busy = true;
        break;
      }
    }
    let res;
    let pr = null;
    try {
      // Holding the lock, nothing can be landing: a `landing` label is left over from a crash.
      for (const p of listQueue(gh)) {
        if (labelNames(p).includes('landing')) { setLabels(gh, p, { add: ['queued'], remove: ['landing'] }); report.reset.push(p.number); }
      }
      q = fillQueueState(gh, report);
      if (!q.eligible.length) break;
      pr = q.eligible[0];
      const base = pr.baseRefName || cfg.base;
      // If the base moves before the merge, redo the rebase and validation (bounded).
      for (let k = 1; ; k++) {
        res = await landOne(ctx, pr);
        if (!res.retry) break;
        if (k >= MAX_BASE_RETRIES) { res = { bounced: bounce(gh, pr, `could not land after ${k} tries: ${res.note}`) }; break; }
        pr = gh.prView(pr.number);
      }
      if (res.merged) await wideSweep(ctx, report, base);
    } catch (e) {
      // Never leave `landing` behind.
      if (pr) { try { setLabels(gh, gh.prView(pr.number), { add: ['queued'], remove: ['landing'] }); } catch { /* reported below */ } }
      throw e;
    } finally {
      ctx.lock.release();
    }
    if (res.merged) report.merged.push(res.merged);
    else if (res.bounced) report.bounced.push(res.bounced);
    else if (res.aborted) {
      report.aborted.push(res.aborted);
      if (res.paused) { report.paused = true; break; }
    }
    if (report.paused) break;
  }
  fillQueueState(gh, report);
  return report;
}

async function unpauseRepo(t) {
  const ctx = context(t);
  const { gh, cfg } = ctx;
  if (!gh.isPaused()) return { repo: t.repo, paused: false, sweep: null, note: 'not paused' };
  let sweep = null;
  if (cfg.wideSweep) {
    const r = await runSweep(ctx, cfg.base);
    sweep = { ok: r.ok, cmd: r.cmd, status: r.status };
    if (!r.ok) return { repo: t.repo, paused: true, sweep, note: `wide sweep on ${cfg.base} is still red` };
  }
  gh.setPaused(false);
  return { repo: t.repo, paused: false, sweep, note: 'cleared AGENT_LANDING_PAUSED' };
}

function statusRepo(t) {
  const ctx = context(t);
  const { gh } = ctx;
  const q = classifyQueue(gh, listQueue(gh));
  const holder = ctx.lock.read();
  const lock = holder ? { host: holder.host, pid: holder.pid, ageMin: holder.ageMin, stale: isStale(holder, ctx.cfg.lockTtlMin) } : null;
  const row = (pr) => {
    const l = parseLanding(pr.body);
    return { pr: pr.number, title: pr.title, labels: labelNames(pr).filter((x) => x.startsWith('queue') || x === 'landing'), priority: l.priority, queuedAt: l.queuedAt, attempts: l.bounces.length };
  };
  return {
    repo: t.repo, paused: gh.isPaused(), lock, capacity: ctx.cfg.maxQueued, order: q.eligible.map(row), waiting: q.waiting, held: q.held,
    queueWaiting: listWaiting(gh).map((p) => p.number),
  };
}

function statusText(s) {
  const lines = [`${s.repo}: ${s.paused ? 'PAUSED, ' : ''}lock ${s.lock ? `held by ${s.lock.host} pid ${s.lock.pid}, ${s.lock.ageMin} min${s.lock.stale ? ' (STALE)' : ''}` : 'free'}`];
  s.order.forEach((r, i) => lines.push(`  ${i + 1}. #${r.pr} p${r.priority} ${r.labels.join(',')} ${r.title}`));
  for (const w of s.waiting) lines.push(`  waiting #${w.pr} on ${w.dependsOn.map((d) => `#${d}`).join(', ')}`);
  if (s.queueWaiting.length) lines.push(`  queue full, waiting: ${s.queueWaiting.map((n) => `#${n}`).join(', ')}`);
  if (s.held.length) lines.push(`  held: ${s.held.map((n) => `#${n}`).join(', ')}`);
  if (!s.order.length && !s.waiting.length) lines.push('  queue empty');
  return lines.join('\n');
}

function runText(r) {
  const parts = [`${r.repo}: merged ${r.merged.length}, bounced ${r.bounced.length}, queued ${r.queued}, held ${r.held.length}, waiting for capacity ${r.queueWaiting.length}`];
  if (r.paused) parts.push('  PAUSED (AGENT_LANDING_PAUSED=1): nothing merges until land-queue unpause');
  for (const m of r.merged) parts.push(`  MERGED #${m.pr} ${m.mergeSha || m.sha}${m.rebased ? ' (lander rebase)' : ''}`);
  for (const b of r.bounced) parts.push(`  ${b.parked ? 'PARKED' : 'BOUNCED'} #${b.pr} attempt ${b.attempt}: ${b.reason}`);
  if (r.reset.length) parts.push(`  reset leftover landing: ${r.reset.map((n) => `#${n}`).join(' ')}`);
  for (const a of r.aborted) parts.push(`  ABORTED #${a.pr}: ${a.reason}`);
  if (r.admitted.length) parts.push(`  admitted ${r.admitted.map((n) => `#${n}`).join(' ')}`);
  for (const s of r.stale) parts.push(`  STALE lock: ${s?.host} pid ${s?.pid}, ${s?.ageMin} min (rerun with --reclaim-stale once the holder is gone)`);
  if (r.busy) parts.push('  lock busy: another lander is running');
  if (r.plan) parts.push(`  plan: ${r.plan.map((n) => `#${n}`).join(' ')}`);
  for (const a of r.alerts) parts.push(`  ALERT ${a}`);
  return parts.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: new Set(['all', 'json', 'dry-run', 'reclaim-stale', 'help']),
    options: new Set(['repo', 'root']),
  });
  const cmd = args._[0];
  if (args.help || !cmd) { print(USAGE, false); return cmd ? 0 : 2; }
  if (!['run', 'status', 'unpause'].includes(cmd)) throw new LandError(USAGE, 2);

  let targets;
  if (args.all) {
    // One repo that cannot be resolved is reported as an error; the others still run.
    targets = registeredRepos().map((root) => {
      try { return target(root); } catch (e) { return { root, repo: path.basename(root), error: e.message }; }
    });
    if (!targets.length) throw new LandError('no repos registered in ~/.agents/state/repos.json with an .agents/repo.json', 2);
  } else {
    targets = [target(args.root ? path.resolve(args.root) : repoTop(), args.repo)];
  }

  const reports = [];
  let failed = 0;
  for (const t of targets) {
    if (t.error) { failed++; reports.push({ repo: t.repo, error: t.error }); continue; }
    try {
      if (cmd === 'run') reports.push(await runRepo(t, { dryRun: Boolean(args['dry-run']), reclaimStale: Boolean(args['reclaim-stale']) }));
      else if (cmd === 'status') reports.push(statusRepo(t));
      else reports.push(await unpauseRepo(t));
    } catch (e) {
      failed++;
      reports.push({ repo: t.repo, error: e instanceof LandError ? e.message : String(e?.message || e) });
    }
  }
  const text = (r) => {
    if (r.error) return `${r.repo}: ERROR ${r.error}`;
    if (cmd === 'run') return runText(r);
    if (cmd === 'status') return statusText(r);
    return `${r.repo}: ${r.paused ? 'still PAUSED' : 'not paused'} (${r.note})`;
  };
  if (args.json) print(args.all ? reports : reports[0], true);
  else for (const r of reports) print(text(r), false);
  if (cmd === 'unpause' && reports.some((r) => r.paused)) return 1;
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`land-queue: ${e instanceof LandError ? e.message : e?.stack || e}\n`);
  process.exitCode = e instanceof LandError ? e.code : 1;
});
