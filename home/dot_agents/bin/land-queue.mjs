// land-queue: the per-repo lander. Lands `queued` PRs one at a time, serially per repo.
// The rules: pr-workflow skill, section 4.
//
// Usage:
//   node land-queue.mjs run     [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]
//   node land-queue.mjs status  [--repo owner/name] [--root <checkout>] [--all] [--json]
//   node land-queue.mjs unpause [--repo owner/name] [--root <checkout>] [--json]
//
// Repos: --root (default: the current checkout); --all reads ~/.agents/state/repos.json.
// A run first recovers a crashed run: under the landing lock, every leftover `landing` label goes
// back to `queued` (queue-hold kept). Then each round: stop if the repo is paused (repo variable
// AGENT_LANDING_PAUSED=1); admit the oldest `queue-waiting` PRs while the unheld queued + landing
// PRs are fewer than maxQueued; take the lock; land the first PR in order (queue-next,
// Linear-Priority 1..4 with 0/missing = 3, time queued, number):
//   head == gated sha -> rebase in <main checkout>-lander -> unchanged? -> setup + affectedGate
//   (one retry) -> re-check -> push --force-with-lease -> re-check -> final base check -> final
//   label/head/pause/lock check -> merge pinned -> clear queue labels -> release.
// "Unchanged" = no conflict, every commit `=` in `git range-diff <old base>..<gated>
// <new base>..<rebased>`, and the rebased diff touches no path the gated diff did not.
// The re-checks re-read the PR: a changed base or head branch, an unmerged Depends-on,
// queue-hold, a pause, a changed head or a lost lock aborts without a merge and puts the PR back
// to `queued` (queue-hold kept); the next round starts its validation again. The final base check
// refetches the base right before the merge; if it moved, the rebase and validation run again
// (at most 3 times, then a bounce). An error mid-landing also puts the PR back to `queued`:
// `landing` is never left behind. Anything else that fails bounces the PR: queued/landing ->
// queue-blocked, one comment with the reason, and a `Bounced:` line in its `## Landing` section.
// The third bounce (after two automatic fix attempts) parks it: the comment starts with `PARKED:`.
// A red wide sweep (every sweepEveryMerges merges, or overdue when the lander is idle) sets
// AGENT_LANDING_PAUSED=1; `unpause` takes the landing lock, reruns the sweep on the base and
// clears the flag only when it is green.
// A stale lock (older than its ttl) is reported, and reclaimed only with --reclaim-stale.
// Output (--json): one report per repo
//   {repo, merged:[{pr,sha,mergeSha,rebased}], bounced:[{pr,reason,attempt,parked}], admitted:[n],
//    aborted:[{pr,reason}], reset:[n], queued, held:[n], waiting:[{pr,dependsOn}], queueWaiting:[n],
//    stale:[{host,pid,ageMin}], busy, paused, alerts:[...], sweep}
// Exit: 0 when every repo was processed (bounces included), 1 on an error, 2 on bad usage.
import path from 'node:path';
import {
  BOUNCE_MARKER, Gh, LandError, LandingLock,
  appendLanding, baseTreeOf, bumpMergeCount, capacityUsed, captureToken, childEnv, classifyQueue, dueSweep, fetchBranch,
  firstLine, git, gitOk, isAncestor, isStale, labelNames, landerCheckout, listQueue, listWaiting, loadRepoConfig,
  mainCheckout, mergePinned, parseArgs, parseLanding, print, rangeDiffChanges, registeredRepos, repoTop, resetTo,
  retainedLockMessage, runCommands, runSweep, scrub, setLabels, slugFromRemote, sweepDue, unmetDeps, waitForPr,
} from './lib/land.mjs';

const USAGE = 'usage: node land-queue.mjs <run|status|unpause> [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]';
const MAX_PRS_PER_RUN = 50;
const MAX_BASE_RETRIES = 3;
const MAX_AUTO_FIXES = 2;

function changedPaths(dir, from, to) {
  return new Set(gitOk(['diff', '--name-only', '--no-renames', from, to], { cwd: dir }).split(/\r?\n/).filter(Boolean));
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

// ---------------------------------------------------------------- re-checks

// One fresh read of the PR, every check on that same object: still open, the same base and
// head branch as validated, every Depends-on merged, no queue-hold, the expected head; then
// the pause flag and lock ownership. Used before the push and twice before the merge (around
// the final base check), so no read that a merge relies on goes unchecked.
function recheck(gh, pr, want, expectHead, lock) {
  const p = gh.prView(pr.number);
  if (p.state !== 'OPEN') return { stop: `PR is ${p.state}` };
  pr.labels = p.labels;
  pr.body = p.body;
  if ((p.baseRefName || want.base) !== want.base) return { requeue: `base changed to ${p.baseRefName}` };
  if (p.headRefName !== want.headRef) return { requeue: `head branch changed to ${p.headRefName}` };
  if (p.headRefOid !== expectHead) return { requeue: `head changed to ${p.headRefOid.slice(0, 12)}` };
  if (labelNames(p).includes('queue-hold')) return { requeue: 'queue-hold appeared' };
  const deps = unmetDeps(gh, p);
  if (deps.length) return { requeue: `Depends-on ${deps.map((d) => `#${d}`).join(', ')} not merged` };
  if (gh.isPaused()) return { requeue: 'repo paused', paused: true };
  if (!lock.stillHeld()) return { requeue: 'the landing lock was lost', lost: true };
  return null;
}

// A failed re-check never merges: the PR goes back to `queued` (queue-hold kept) and the next
// round starts its validation again; a closed PR just loses `landing`.
function abort(gh, pr, r, stage) {
  if (r.stop) {
    setLabels(gh, pr, { remove: ['landing'] });
    return { aborted: { pr: pr.number, reason: `${r.stop} before ${stage}` } };
  }
  setLabels(gh, pr, { add: ['queued'], remove: ['landing'] });
  return { aborted: { pr: pr.number, reason: `${r.requeue} before ${stage}` }, paused: Boolean(r.paused), lost: Boolean(r.lost) };
}

// ---------------------------------------------------------------- one PR

async function landOne(ctx, pr) {
  const { gh, cfg, mainRoot, lock, root } = ctx;
  setLabels(gh, pr, { add: ['landing'], remove: ['queued'] });
  const gated = parseLanding(pr.body).gatedSha;
  if (!gated) return { bounced: bounce(gh, pr, 'no `Gate: pass @ <sha>` line in the ## Landing section') };
  if (!pr.headRefOid.startsWith(gated)) {
    return { bounced: bounce(gh, pr, `head changed after the gate (head ${pr.headRefOid.slice(0, 12)}, gated ${gated.slice(0, 12)})`) };
  }
  const head = pr.headRefOid;
  const base = pr.baseRefName || cfg.base;
  const want = { base, headRef: pr.headRefName };
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
    // Repo hooks (pre-rebase, post-rewrite) run here: without the token, like every child.
    const rb = git(['-c', 'rebase.autoSquash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', newBase], {
      cwd: dir, env: childEnv({ GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }),
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
    if (!g.ok && !g.lost) g = await runCommands(cfg.affectedGate, dir, lock, cfg.lockTtlMin);
    if (g.lost) { resetTo(dir, baseRef); return abort(gh, pr, { requeue: 'the landing lock was lost during the gate', lost: true }, 'the push'); }
    if (!g.ok) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `affected gate failed after the rebase (\`${g.cmd}\` exit ${g.status}, retried once)`, g.tail) };
    }
    landSha = rebasedSha;
    const pre = recheck(gh, pr, want, head, lock);
    if (pre) { resetTo(dir, baseRef); return abort(gh, pr, pre, 'the push'); }
    const push = git(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, 'origin', `${landSha}:refs/heads/${pr.headRefName}`], { cwd: dir });
    resetTo(dir, baseRef);
    if (push.status !== 0) return { bounced: bounce(gh, pr, `push of the rebased head was rejected: ${firstLine(push.stderr || push.stdout)}`) };
    const body = appendLanding(pr.body, `Gate: pass @ ${landSha} (lander rebase)`);
    gh.prEdit(pr.number, { body });
    pr.body = body;
    const seen = waitForPr(gh, pr.number, (p) => p.headRefOid === landSha);
    if (seen.headRefOid !== landSha) return { retry: true, note: 'GitHub has not seen the pushed head yet' };
  }

  // Right before the merge: the full re-check; then the final base check (a moved base means
  // the caller redoes the rebase and validation); then the full re-check again, the last read.
  const first = recheck(gh, pr, want, landSha, lock);
  if (first) return abort(gh, pr, first, 'the merge');
  fetchBranch(dir, base);
  if (!isAncestor(baseRef, landSha, dir)) return { retry: true, note: `${base} moved during the landing` };
  const last = recheck(gh, pr, want, landSha, lock);
  if (last) return abort(gh, pr, last, 'the merge');
  const m = mergePinned(gh, cfg, { pr: pr.number, sha: landSha, cwd: root });
  if (!m.ok) return { bounced: bounce(gh, pr, `merge failed: ${m.message}`) };
  return { merged: { pr: pr.number, sha: landSha, mergeSha: m.mergeSha, rebased } };
}

// ---------------------------------------------------------------- capacity

// Move the oldest queue-waiting PRs to queued while the unheld queued + landing PRs are fewer
// than maxQueued.
function admitWaiting(ctx, report) {
  const { gh, cfg } = ctx;
  let free = cfg.maxQueued - capacityUsed(listQueue(gh));
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

// ---------------------------------------------------------------- per repo

function target(root, slug) {
  const repo = slug || slugFromRemote(root);
  if (!repo) throw new LandError(`cannot tell the GitHub repo of ${root}; pass --repo owner/name`, 2);
  return { root, repo };
}

function context(t, opts = {}) {
  const cfg = loadRepoConfig(t.root, opts);
  const gh = new Gh({ repo: t.repo });
  return { gh, cfg, root: t.root, mainRoot: mainCheckout(t.root), lock: new LandingLock(gh, { ttlMin: cfg.lockTtlMin, cwd: t.root }) };
}

function fillQueueState(gh, report) {
  const q = classifyQueue(gh, listQueue(gh));
  report.queued = q.eligible.length + q.waiting.length;
  report.held = q.held;
  report.waiting = q.waiting;
  report.queueWaiting = listWaiting(gh).map((p) => p.number);
  return q;
}

// Take the lock, or record why not (busy, or stale and not reclaimed). True when held.
function takeLock(ctx, report, opts) {
  fetchBranch(ctx.root, ctx.cfg.base);
  const got = ctx.lock.acquire(baseTreeOf(ctx.root, `refs/remotes/origin/${ctx.cfg.base}`));
  if (got.held) return true;
  const h = got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null;
  if (got.stale && opts.reclaimStale && ctx.lock.reclaim(got.holder)) {
    report.alerts.push(`reclaimed a stale landing lock (${h?.ageMin} min old)`);
    return true;
  }
  if (got.stale) report.stale.push(h); else report.busy = true;
  return false;
}

// Release the lock; one that could not be deleted while still ours is reported (it blocks every
// lander until its ttl), and the run stops.
function releaseLock(ctx, report) {
  if (ctx.lock.release()) return true;
  report.lockRetained = ctx.lock.retained;
  report.alerts.push(retainedLockMessage(ctx.lock));
  return false;
}

// Holding the lock, nothing can be landing: a `landing` label is left over from a crash.
function resetLeftovers(gh, report) {
  for (const p of listQueue(gh)) {
    if (!labelNames(p).includes('landing')) continue;
    setLabels(gh, p, { add: ['queued'], remove: ['landing'] });
    if (!report.reset.includes(p.number)) report.reset.push(p.number);
  }
}

// A due sweep, caught on its own: a sweep that throws never touches a merged PR.
async function sweepAfter(ctx, report) {
  try {
    const s = await dueSweep(ctx);
    if (!s) return;
    report.sweep = { ran: true, ok: s.ok, afterMerges: s.afterMerges };
    if (s.alert) report.alerts.push(s.alert);
    if (s.paused) report.paused = true;
  } catch (e) {
    report.sweep = { ran: false, ok: false, error: firstLine(e?.message || e) };
    report.alerts.push(`wide sweep could not run: ${firstLine(e?.message || e)}; it stays due and runs again next time`);
  }
}

async function runRepo(t, opts) {
  const ctx = context(t);
  const { gh } = ctx;
  const report = {
    repo: t.repo, merged: [], bounced: [], admitted: [], aborted: [], reset: [], queued: 0, held: [], waiting: [], queueWaiting: [],
    stale: [], busy: false, paused: false, alerts: [], sweep: null,
  };
  if (!opts.dryRun) {
    gh.ensureLabels();
    // Recover a crashed run first, whatever else stops this one (a pause, nothing eligible).
    if (listQueue(gh).some((p) => labelNames(p).includes('landing'))) {
      if (!takeLock(ctx, report, opts)) { fillQueueState(gh, report); return report; }
      let kept = false;
      try { resetLeftovers(gh, report); } finally { kept = !releaseLock(ctx, report); }
      if (kept) { fillQueueState(gh, report); return report; }
    }
  }
  let lost = false;
  for (let i = 0; i < MAX_PRS_PER_RUN; i++) {
    if (gh.isPaused()) { report.paused = true; break; }
    if (!opts.dryRun) admitWaiting(ctx, report);
    let q = fillQueueState(gh, report);
    if (!q.eligible.length) break;
    if (opts.dryRun) { report.plan = q.eligible.map((p) => p.number); break; }
    if (!takeLock(ctx, report, opts)) break;
    let res = null;
    let pr = null;
    try {
      resetLeftovers(gh, report);
      q = fillQueueState(gh, report);
      if (q.eligible.length) {
        pr = q.eligible[0];
        // If the base moves before the merge, redo the rebase and validation (bounded).
        for (let k = 1; ; k++) {
          res = await landOne(ctx, pr);
          if (!res.retry) break;
          if (k >= MAX_BASE_RETRIES) { res = { bounced: bounce(gh, pr, `could not land after ${k} tries: ${res.note}`) }; break; }
          pr = gh.prView(pr.number);
        }
      }
      if (res?.merged) {
        report.merged.push(res.merged);
        bumpMergeCount(gh.repo);
        await sweepAfter(ctx, report);
      }
    } catch (e) {
      // Never leave `landing` behind; a merged PR is never put back in line.
      if (pr && !res?.merged) { try { setLabels(gh, gh.prView(pr.number), { add: ['queued'], remove: ['landing'] }); } catch { /* reported below */ } }
      throw e;
    } finally {
      if (!releaseLock(ctx, report)) lost = true;
    }
    if (!res) break;
    if (res.bounced) report.bounced.push(res.bounced);
    else if (res.aborted) {
      report.aborted.push(res.aborted);
      if (res.paused) report.paused = true;
      if (res.lost) { lost = true; report.alerts.push(`the landing lock was lost while landing #${res.aborted.pr}; stopped`); }
    }
    if (report.paused || lost) break;
  }
  // A sweep that is overdue (merges by land-pr, or a run that stopped before its sweep) runs when
  // nothing else is in the way.
  if (!opts.dryRun && !report.paused && !report.busy && !report.stale.length && !lost && sweepDue(gh.repo, ctx.cfg) && !gh.isPaused()) {
    if (takeLock(ctx, report, opts)) {
      try { await sweepAfter(ctx, report); } finally { releaseLock(ctx, report); }
    }
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
    // The sweep runs in the lander checkout: only while holding the landing lock.
    const probe = { stale: [], busy: false, alerts: [] };
    if (!takeLock(ctx, probe, {})) {
      return { repo: t.repo, paused: true, sweep: null, busy: true, note: probe.stale.length ? 'the landing lock is stale; the lander reclaims it' : 'the landing lock is busy; try again after the lander finishes' };
    }
    let r;
    try {
      r = await runSweep(ctx);
      sweep = { ok: r.ok, cmd: r.cmd, status: r.status };
    } finally {
      if (!releaseLock(ctx, probe)) process.stderr.write(`WARNING: ${probe.alerts.at(-1)}\n`);
    }
    if (!r.ok) return { repo: t.repo, paused: true, sweep, note: `wide sweep on ${cfg.base} is still red`, lockRetained: probe.lockRetained || null };
  }
  gh.setPaused(false);
  return { repo: t.repo, paused: false, sweep, note: 'cleared AGENT_LANDING_PAUSED' };
}

function statusRepo(t) {
  const ctx = context(t, { needGate: false });
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
  captureToken();
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
