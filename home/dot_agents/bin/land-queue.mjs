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
// queue-blocked, one comment with the reason (commands, exit codes, paths, SHAs; never command
// output), and a `Bounced:` line in its `## Landing` section. A repo command that runs longer than
// commandTimeoutMin (default 60) is stopped with every process it started.
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
  depName,
  BOUNCE_MARKER, Gh, LandError, LandingLock,
  appendLanding, baseTreeOf, clearQueueLabels, confirmPending, bumpMergeCount, capacityUsed, captureToken, childEnv, classifyQueue, dueSweep, fetchBranch,
  firstLine, git, gitOk, isAncestor, isStale, labelNames, landerCheckout, listQueue, listWaiting, loadRepoConfig,
  mainCheckout, mergePinned, parseArgs, parseLanding, print, rangeDiffChanges, registeredRepos, repoTop, resetTo,
  named, resolveRepo, retainedLockMessage, runCommands, runStep, runSweep, scrub, setLabels, sweepCommands, sweepDue, unmetDeps,
  validateLandingCommands, waitForPr,
} from './lib/land.mjs';

const USAGE = 'usage: node land-queue.mjs <run|status|unpause> [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]';
const MAX_PRS_PER_RUN = 50;
const MAX_BASE_RETRIES = 3;
const MAX_AUTO_FIXES = 2;

// The branch's head on origin, read with git (not the GitHub API); null when it cannot be read.
function remoteHead(cwd, branch) {
  const r = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd });
  if (r.status !== 0) return null;
  const sha = r.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/.test(sha || '') ? sha : null;
}

function changedPaths(dir, from, to) {
  return new Set(gitOk(['diff', '--name-only', '--no-renames', from, to], { cwd: dir }).split(/\r?\n/).filter(Boolean));
}

// ---------------------------------------------------------------- bounce

// A bounce changes the PR (body, labels, comment): only while this lander still owns the lock.
// After a loss the PR is left for the next lander, like an abort.
function bounceOwned(ctx, pr, reason) {
  if (!ctx.lock.stillHeld()) return { aborted: { pr: pr.number, reason: 'the landing lock was lost; the PR is left for the next lander' }, lost: true };
  return { bounced: bounce(ctx.gh, pr, reason) };
}

// The reason is a summary built here (commands, exit codes, paths, SHAs); the output of a
// command never goes into a PR comment, where a secret it printed would be public.
function bounce(gh, pr, rawReason) {
  // One scrubbed reason for every destination: the PR body, the comment and the report.
  const reason = scrub(rawReason);
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
  lines.push('', 'Command output is not posted here; run the command in your worktree to see it.', '', BOUNCE_MARKER);
  gh.prComment(pr.number, `${lines.join('\n')}\n`);
  return { pr: pr.number, reason: scrub(reason), attempt, parked };
}

// ---------------------------------------------------------------- re-checks

// One fresh read of the PR, every check on that same object: still open, the same base and
// head branch as validated, every Depends-on merged, no queue-hold, the expected head; then
// the pause flag and lock ownership. Used before the push and twice before the merge (around
// the final base check), so no read that a merge relies on goes unchecked.
function recheck(gh, pr, want, expectHead, lock) {
  // Ownership first: any other reason found after a loss must not lead to changes of ours.
  if (!lock.stillHeld()) return { requeue: 'the landing lock was lost', lost: true };
  const p = gh.prView(pr.number);
  if (p.state !== 'OPEN') return { stop: `PR is ${p.state}` };
  if (p.isCrossRepository) return { stop: 'the PR is from a fork' };
  pr.labels = p.labels;
  pr.body = p.body;
  if ((p.baseRefName || want.base) !== want.base) return { requeue: `base changed to ${p.baseRefName}` };
  if (p.headRefName !== want.headRef) return { requeue: `head branch changed to ${p.headRefName}` };
  if (p.headRefOid !== expectHead) return { requeue: `head changed to ${p.headRefOid.slice(0, 12)}` };
  if (labelNames(p).includes('queue-hold')) return { requeue: 'queue-hold appeared' };
  if (p.isDraft) return { requeue: 'the PR was made a draft' };
  const deps = unmetDeps(gh, p);
  if (deps.length) return { requeue: `Depends-on ${deps.map(depName).join(', ')} not merged` };
  if (gh.isPaused()) return { requeue: 'repo paused', paused: true };
  if (!lock.stillHeld()) return { requeue: 'the landing lock was lost', lost: true };
  return null;
}

// A failed re-check never merges: the PR goes back to `queued` (queue-hold kept) and the next
// round starts its validation again; a closed PR just loses `landing`.
function abort(gh, pr, r, stage, lock) {
  // Ownership first: a lock lost at any point (even alongside another reason) means the PR is
  // not ours to relabel (the new holder may be landing it); the next lander recovers a leftover
  // `landing` under its own lock.
  if (!r.lost && lock && !lock.stillHeld()) r = { ...r, lost: true };
  if (r.stop && !r.lost) {
    setLabels(gh, pr, { remove: ['landing'] });
    return { aborted: { pr: pr.number, reason: `${r.stop} before ${stage}` } };
  }
  if (r.stop) return { aborted: { pr: pr.number, reason: `${r.stop} before ${stage}; the landing lock was lost` }, lost: true };
  if (!r.lost) setLabels(gh, pr, { add: ['queued'], remove: ['landing'] });
  return { aborted: { pr: pr.number, reason: `${r.requeue} before ${stage}` }, paused: Boolean(r.paused), lost: Boolean(r.lost) };
}

// ---------------------------------------------------------------- one PR

async function landOne(ctx, pr, wantIn = null) {
  const { gh, cfg, mainRoot, lock, root } = ctx;
  // A retry after a moved base starts here again: nothing is changed unless the lock is ours.
  if (!lock.stillHeld()) return { aborted: { pr: pr.number, reason: 'the landing lock was lost before the landing' }, lost: true };
  // A fork PR's head is not on origin: a same-named origin branch (even at the same sha) is
  // someone else's, and a rebased push would rewrite it. Fork PRs are refused before any fetch.
  if (pr.isCrossRepository) return bounceOwned(ctx, pr, 'the PR is from a fork, which the land queue does not land; merge it by hand');
  setLabels(gh, pr, { add: ['landing'], remove: ['queued'] });
  let gated = parseLanding(pr.body).gatedSha;
  // A head that this lander rebased, gated and pushed, whose `pass` line was never written (the
  // edit after the push failed), is the gated head: its `pending` line says so.
  if (parseLanding(pr.body).pending.includes(pr.headRefOid) && (!gated || !pr.headRefOid.startsWith(gated))) {
    const body = confirmPending(pr.body, pr.headRefOid);
    gh.prEdit(pr.number, { body });
    pr.body = body;
    gated = pr.headRefOid;
  }
  if (!gated) return bounceOwned(ctx, pr, 'no `Gate: pass @ <sha>` line in the ## Landing section');
  // The gate proves its sha against one base: the base on that same line. A line without a base
  // proves none; a PR that now targets another base was never gated there. Both need a new gate
  // and review on the PR's base, then land-pr; the lander never moves an old proof to a new base.
  const gatedBase = parseLanding(pr.body).gatedBase;
  if (!gatedBase) return bounceOwned(ctx, pr, 'the gate line names no base (`Gate: pass @ <sha> base=<branch>`): run the gate and the review on the PR base, then land-pr again');
  const prBase = pr.baseRefName || cfg.base;
  if (prBase !== gatedBase) return bounceOwned(ctx, pr, `the PR targets ${prBase}, but its gate ran against ${gatedBase}: re-gate and re-review on ${prBase}, then land-pr again`);
  if (!pr.headRefOid.startsWith(gated)) {
    // GitHub can lag behind a push: it may still show the head this lander replaced (the gate
    // before its last `lander rebase` gate). The branch itself decides: if origin already has the
    // gated head, the PR goes back to queued for the next run, with no bounce. Any other head is
    // a change after the gate.
    const gates = parseLanding(pr.body).gates;
    const last = gates[gates.length - 1];
    if (gates.length >= 2 && /lander rebase/.test(last.note) && pr.headRefOid === gates[gates.length - 2].sha
      && remoteHead(mainRoot, pr.headRefName) === last.sha) {
      return { ...abort(gh, pr, { requeue: `GitHub still shows the head before the lander rebase (${pr.headRefOid.slice(0, 12)}; the branch has ${last.sha.slice(0, 12)})` }, 'landing', lock), stop: true };
    }
    return bounceOwned(ctx, pr, `head changed after the gate (head ${pr.headRefOid.slice(0, 12)}, gated ${gated.slice(0, 12)})`);
  }
  const head = pr.headRefOid;
  // The base is the gated base; a retry keeps the base and head branch the first attempt
  // validated (never a new target).
  const want = wantIn || { base: gatedBase, headRef: pr.headRefName };
  const { base } = want;
  const baseRef = `refs/remotes/origin/${base}`;
  const dir = landerCheckout(mainRoot, base);
  // Resets of the checkout happen only while this lander still owns the lock: after a loss it
  // may be another lander's.
  const resetOwned = () => { if (lock.stillHeld()) resetTo(dir, baseRef); };
  fetchBranch(dir, base);
  const f = git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`], { cwd: dir });
  if (f.status !== 0) return bounceOwned(ctx, pr, `cannot fetch ${pr.headRefName} from origin (fork PRs are not supported)`);
  const fetched = gitOk(['rev-parse', '--verify', `refs/remotes/origin/${pr.headRefName}^{commit}`], { cwd: dir });
  if (fetched !== head) return bounceOwned(ctx, pr, `branch moved while landing (origin has ${fetched.slice(0, 12)})`);

  let landSha = head;
  let rebased = false;
  if (!isAncestor(baseRef, head, dir)) {
    rebased = true;
    const forkPoint = gitOk(['merge-base', baseRef, head], { cwd: dir });
    const newBase = gitOk(['rev-parse', baseRef], { cwd: dir });
    // A plain rebase drops merge commits, and with them any change made only in a merge (a
    // conflict resolution): range-diff skips merges and the path check sees no new path, so that
    // loss would pass. A branch with merges is rebased by hand, then re-gated and re-reviewed.
    const merges = git(['rev-list', '--merges', `${forkPoint}..${head}`], { cwd: dir });
    if (merges.status !== 0) return bounceOwned(ctx, pr, `cannot list the branch's commits (git rev-list exit ${merges.status})`);
    const mergeCount = merges.stdout.split(/\r?\n/).filter(Boolean).length;
    if (mergeCount) return bounceOwned(ctx, pr, `the branch has ${mergeCount} merge commit(s), which an automatic rebase would drop; rebase it onto ${base} by hand, then re-gate and re-review`);
    // The reads and fetches above take time: the checkout is reset only while the lock is ours.
    if (!lock.stillHeld()) return abort(gh, pr, { requeue: 'the landing lock was lost', lost: true }, 'the rebase', lock);
    resetTo(dir, head);
    // Repo hooks (pre-rebase, post-rewrite) run here: without the token, like every child, as a
    // landing step (lock refreshed, command timeout).
    const rb = await runStep(['git', '-c', 'rebase.autoSquash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', newBase], {
      cwd: dir, env: childEnv({ GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }), lock, cfg, label: `the rebase onto ${base}`,
    });
    // Lost: the checkout may be another lander's. Stuck: a hook may still run in it (the lock is
    // kept). Either way nothing is aborted, reset or relabelled here.
    if (rb.lost) return abort(gh, pr, { requeue: 'the landing lock was lost during the rebase', lost: true }, 'the push', lock);
    if (rb.stuck) return { aborted: { pr: pr.number, reason: `the rebase onto ${base} timed out; the landing lock is kept and the checkout left as it is` }, stop: true };
    if (rb.status !== 0) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split(/\r?\n/).filter(Boolean);
      git(['rebase', '--abort'], { cwd: dir });
      resetOwned();
      const list = files.slice(0, 10).join(', ');
      return bounceOwned(ctx, pr, `rebase onto ${base} conflicts in ${files.length} file(s)${list ? `: ${list}` : ''}; re-gate and re-review after resolving`);
    }
    const rebasedSha = gitOk(['rev-parse', 'HEAD'], { cwd: dir });
    const rd = git(['range-diff', '--no-color', `${forkPoint}..${head}`, `${newBase}..${rebasedSha}`], { cwd: dir });
    if (rd.status !== 0) {
      resetOwned();
      return bounceOwned(ctx, pr, `git range-diff failed (exit ${rd.status})`);
    }
    const changes = rangeDiffChanges(rd.stdout);
    if (changes.total === 0 || changes.changed.length) {
      resetOwned();
      const what = changes.total === 0 ? 'the rebase left no commits' : `the rebase changed ${changes.changed.length} of ${changes.total} commit(s)`;
      return bounceOwned(ctx, pr, `${what}; re-gate and re-review`);
    }
    const before = changedPaths(dir, forkPoint, head);
    const added = [...changedPaths(dir, newBase, rebasedSha)].filter((p) => !before.has(p));
    if (added.length) {
      resetOwned();
      return bounceOwned(ctx, pr, `the rebased diff touches ${added.length} new path(s): ${added.slice(0, 10).join(', ')}; re-gate and re-review`);
    }
    // Same patches on a newer base: rerun the affected gate only.
    // A failed gate gets one retry; a lost lock or a timeout does not.
    let g = await runCommands([...named('setup', cfg.setup), ...named('affectedGate', cfg.affectedGate)], dir, lock, cfg);
    let retried = false;
    // Only a red affected gate is retried; a failed setup is a failure as it stands.
    if (!g.ok && !g.lost && !g.timedOut && String(g.name || '').startsWith('affectedGate')) {
      retried = true;
      g = await runCommands(named('affectedGate', cfg.affectedGate), dir, lock, cfg);
    }
    // A lost lock: the checkout may be another lander's now (and processes this gate started may
    // survive), so it is left as it is.
    if (g.lost) return abort(gh, pr, { requeue: 'the landing lock was lost during the gate', lost: true }, 'the push', lock);
    // A gate that could not be stopped may still use the checkout: no reset; the lock is kept
    // (runCommands) and the run stops when it is not released.
    if (g.stuck) return bounceOwned(ctx, pr, `affected gate failed: ${g.summary}, after the rebase`);
    if (!g.ok) {
      resetOwned();
      return bounceOwned(ctx, pr, `affected gate failed: ${g.summary}${retried ? ' (retried once)' : ''}, after the rebase`);
    }
    landSha = rebasedSha;
    const pre = recheck(gh, pr, want, head, lock);
    if (pre) { if (!pre.lost) resetOwned(); return abort(gh, pr, pre, 'the push', lock); }
    // Record the gated rebased head before pushing it, as pending: if recording `pass` after the
    // push fails, the next run recognises the pushed head as this lander's gated one.
    const pendingBody = appendLanding(pr.body, `Gate: pending @ ${landSha} (lander rebase, push started) base=${base}`);
    gh.prEdit(pr.number, { body: pendingBody });
    pr.body = pendingBody;
    // The push runs the repo's pre-push hook: a landing step (lock refreshed, command timeout).
    const push = await runStep(['git', 'push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, 'origin', `${landSha}:refs/heads/${pr.headRefName}`], {
      cwd: dir, env: childEnv(), lock, cfg, label: 'the push of the rebased head',
    });
    // Lost or stuck: the push may still complete, and the pending line already names its head
    // for the next lander. Nothing is reset or relabelled; a stuck push keeps the lock.
    if (push.lost) return abort(gh, pr, { requeue: 'the landing lock was lost during the push', lost: true }, 'the merge', lock);
    if (push.stuck) return { aborted: { pr: pr.number, reason: 'the push of the rebased head timed out (it may still complete); the landing lock is kept and the checkout left as it is' }, stop: true };
    resetOwned();
    if (push.status !== 0) return bounceOwned(ctx, pr, `push of the rebased head was rejected (git push exit ${push.status}: a repo hook or the remote refused it)`);
    // The pending line already names the pushed head: after a loss it is left for the next lander.
    if (!lock.stillHeld()) return abort(gh, pr, { requeue: 'the landing lock was lost after the push', lost: true }, 'the merge', lock);
    const body = confirmPending(pr.body, landSha);
    gh.prEdit(pr.number, { body });
    pr.body = body;
    const seen = waitForPr(gh, pr.number, (p) => p.headRefOid === landSha);
    // GitHub lagging behind the push is not the PR's fault: back to queued, no bounce; the next
    // run recognises the pushed head (see the gate check above).
    if (seen.headRefOid !== landSha) return { ...abort(gh, pr, { requeue: 'GitHub has not shown the pushed head yet' }, 'the merge', lock), stop: true };
  }

  // Right before the merge: the full re-check; then the final base check (a moved base means
  // the caller redoes the rebase and validation); then the full re-check again, the last read.
  const first = recheck(gh, pr, want, landSha, lock);
  if (first) return abort(gh, pr, first, 'the merge', lock);
  fetchBranch(dir, base);
  if (!isAncestor(baseRef, landSha, dir)) return { retry: true, note: `${base} moved during the landing`, want };
  const last = recheck(gh, pr, want, landSha, lock);
  if (last) return abort(gh, pr, last, 'the merge', lock);
  const m = await mergePinned(gh, cfg, { pr: pr.number, sha: landSha, cwd: root, lock });
  // Lost: nothing more is changed. Stuck: the merge may still happen, so no bounce; the lock is
  // kept and `landing` stays for the next lander's recovery.
  if (!m.ok && m.lost) return abort(gh, pr, { requeue: m.summary, lost: true }, 'the merge', lock);
  if (!m.ok && m.stuck) return { aborted: { pr: pr.number, reason: m.summary }, stop: true };
  if (!m.ok) return bounceOwned(ctx, pr, `merge failed (${m.summary})`);
  // Merged, but the lock was lost or the merge command timed out: counted, and the run stops.
  return { merged: { pr: pr.number, sha: landSha, mergeSha: m.mergeSha, rebased }, stop: Boolean(m.lost || m.stuck), lost: Boolean(m.lost), stuck: Boolean(m.stuck), readBack: m.readBack };
}

// ---------------------------------------------------------------- capacity

// Move the oldest queue-waiting PRs to queued while the unheld queued + landing PRs are fewer
// than maxQueued.
function admitWaiting(ctx, report) {
  const { gh, cfg, lock } = ctx;
  let free = cfg.maxQueued - capacityUsed(listQueue(gh));
  if (free <= 0) return true;
  for (const w of listWaiting(gh)) {
    if (free <= 0) break;
    if (labelNames(w).includes('queue-hold')) continue;
    // Admission counts free slots under the lock: after a loss another lander admits.
    if (!lock.stillHeld()) return false;
    const gated = parseLanding(w.body).gatedSha;
    if (!gated || !w.headRefOid.startsWith(gated)) {
      report.bounced.push(bounce(gh, w, 'head changed while waiting for queue capacity'));
      continue;
    }
    setLabels(gh, w, { add: ['queued'], remove: ['queue-waiting'] });
    report.admitted.push(w.number);
    free--;
  }
  return true;
}

// ---------------------------------------------------------------- per repo

function target(root, slug) {
  const repo = resolveRepo(root, slug);
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
  report.drafts = q.drafts;
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
function resetLeftovers(gh, report, lock) {
  for (const p of listQueue(gh)) {
    if (!labelNames(p).includes('landing')) continue;
    // After a loss, `landing` may be the new holder's PR in flight: it is not reset.
    if (lock && !lock.stillHeld()) return false;
    setLabels(gh, p, { add: ['queued'], remove: ['landing'] });
    if (!report.reset.includes(p.number)) report.reset.push(p.number);
  }
  return true;
}

// After an error mid-landing, settle the PR from a fresh read: never leave `landing`, and never
// put a bounced (queue-blocked) or merged PR back in line. A merge that went through (the error
// came after it, for example while reading the PR back) is counted: returns { merged }.
function settleAfterError(gh, pr, res, report, lock) {
  if (!pr || res?.merged) return null;
  // Ownership is checked after the fresh read, right before each change: the lock can move
  // during that read, so a check made before it proves nothing.
  const owned = () => !lock || lock.stillHeld();
  let fresh;
  try { fresh = gh.prView(pr.number); } catch { return null; }
  if (fresh.state === 'MERGED') {
    // A confirmed merge; the caller counts it (countMerge). Its labels are cleared only while
    // the lock is ours and no landing step may still run.
    const merged = { pr: pr.number, sha: fresh.headRefOid, mergeSha: fresh.mergeCommit?.oid || null, rebased: null };
    if (!lock?.keepReason && owned()) clearQueueLabels(gh, fresh);
    return { merged };
  }
  if (!owned()) return null;
  try {
    if (fresh.state !== 'OPEN' || labelNames(fresh).includes('queue-blocked')) setLabels(gh, fresh, { remove: ['landing'] });
    else setLabels(gh, fresh, { add: ['queued'], remove: ['landing'] });
  } catch { /* the error itself is reported */ }
  return null;
}

// One decision for every confirmed merge, whether the merge path saw it or a fresh read after
// an error did: it is counted; after a lost lock or a landing step that may still run, the run
// stops (no sweep, reset or other PR); otherwise a sweep it made due runs before anything else
// lands. A merge recovered after an error proves nothing about the lock, so ownership is checked
// first. Returns true when the run must stop.
async function countMerge(ctx, report, merged, { lost = false, stuck = false, recovered = false } = {}) {
  report.merged.push(merged);
  try { bumpMergeCount(ctx.gh.repo); } catch (e) { report.alerts.push(`the merge count was not updated (${firstLine(e?.message || e)}); the next wide sweep may run late`); }
  let why = lost ? 'the landing lock was lost' : stuck ? 'the merge command timed out (the landing lock is kept)' : '';
  if (!why && recovered) {
    if (ctx.lock?.keepReason) why = 'a landing step timed out (the landing lock is kept)';
    else if (ctx.lock && !ctx.lock.stillHeld()) why = 'the landing lock was lost';
  }
  if (why) {
    report.alerts.push(`#${merged.pr} merged, but ${why}: stopped before any sweep or other landing`);
    return true;
  }
  return sweepAfter(ctx, report);
}

// A due sweep, caught on its own: a sweep that throws never touches a merged PR. Returns true
// when the run must stop before anything else lands: the lock was lost, the sweep could not
// finish or record its pause, or it could not run at all (a checkout, config or API error). In
// every one of those the sweep stays due and the next run tries it first.
async function sweepAfter(ctx, report) {
  try {
    const s = await dueSweep(ctx);
    if (!s) return false;
    report.sweep = { ran: true, ok: s.ok, afterMerges: s.afterMerges, lost: Boolean(s.lost) };
    if (s.alert) report.alerts.push(s.alert);
    if (s.paused) report.paused = true;
    return Boolean(s.lost || s.stop);
  } catch (e) {
    report.sweep = { ran: false, ok: false, error: firstLine(e?.message || e) };
    report.alerts.push(`wide sweep could not run: ${firstLine(e?.message || e)}; it stays due, nothing more lands in this run, and it runs again first next time`);
    return true;
  }
}

// One repo's run. An error stops it, and the report so far (merges, bounces, aborts) is kept
// with the error: what already happened is still reported and acted on; the exit is non-zero.
async function runRepo(t, opts) {
  const report = {
    repo: t.repo, merged: [], bounced: [], admitted: [], aborted: [], reset: [], queued: 0, held: [], waiting: [], queueWaiting: [],
    stale: [], busy: false, paused: false, alerts: [], sweep: null,
  };
  try {
    return await runRepoSteps(t, opts, report);
  } catch (e) {
    report.error = scrub(firstLine(e instanceof LandError ? e.message : e?.message || e));
    return report;
  }
}

async function runRepoSteps(t, opts, report) {
  const ctx = context(t);
  const { gh } = ctx;
  // A gate or merge command that cannot be run is a config error before any PR is touched.
  validateLandingCommands(ctx.cfg);
  if (!opts.dryRun) {
    gh.ensureLabels();
    // Recover a crashed run first, whatever else stops this one (a pause, nothing eligible).
    if (listQueue(gh).some((p) => labelNames(p).includes('landing'))) {
      if (!takeLock(ctx, report, opts)) { fillQueueState(gh, report); return report; }
      let kept = false;
      let held = true;
      try { held = resetLeftovers(gh, report, ctx.lock); } finally { kept = !releaseLock(ctx, report); }
      if (!held) report.alerts.push('the landing lock was lost while resetting leftover `landing` labels; stopped');
      if (kept || !held) { fillQueueState(gh, report); return report; }
    }
    // A sweep that is already due (one that failed to pause, or merges by land-pr) runs before
    // anything else lands; if it stops or pauses, nothing lands in this run.
    if (sweepDue(gh.repo, ctx.cfg) && !gh.isPaused()) {
      if (!takeLock(ctx, report, opts)) { fillQueueState(gh, report); return report; }
      let stop = false;
      try { stop = await sweepAfter(ctx, report); } finally { if (!releaseLock(ctx, report)) stop = true; }
      if (stop || report.paused) { fillQueueState(gh, report); return report; }
    }
  }
  let lost = false;
  for (let i = 0; i < MAX_PRS_PER_RUN; i++) {
    if (gh.isPaused()) { report.paused = true; break; }
    let q = fillQueueState(gh, report);
    if (opts.dryRun) { if (q.eligible.length) report.plan = q.eligible.map((p) => p.number); break; }
    // Nothing to land and nothing waiting for a slot: done, without taking the lock.
    if (!q.eligible.length && !report.queueWaiting.length) break;
    if (!takeLock(ctx, report, opts)) break;
    let res = null;
    let pr = null;
    try {
      // Under the lock: crash leftovers, then admission (so two landers never both fill the
      // same free slots), then one PR.
      if (!resetLeftovers(gh, report, ctx.lock) || !admitWaiting(ctx, report)) {
        lost = true;
        report.alerts.push('the landing lock was lost before a landing started; stopped');
      }
      q = fillQueueState(gh, report);
      if (!lost && q.eligible.length) {
        pr = q.eligible[0];
        // If the base moves before the merge, redo the rebase and validation (bounded).
        let want = null;
        for (let k = 1; ; k++) {
          res = await landOne(ctx, pr, want);
          if (!res.retry) break;
          if (k >= MAX_BASE_RETRIES) { res = bounceOwned(ctx, pr, `could not land after ${k} tries: ${res.note}`); break; }
          want = res.want;
          pr = gh.prView(pr.number);
          // The retry's fresh read gets every check before any work: still open (closed or
          // merged: `landing` goes, no bounce), the validated base and branch, no hold, not a
          // draft, Depends-on met, no pause, the lock ours (else back to queued, no bounce).
          const pre = recheck(gh, pr, want, pr.headRefOid, ctx.lock);
          if (pre) { res = abort(gh, pr, pre, 'the retry', ctx.lock); break; }
        }
      }
      if (res?.merged) {
        if (res.readBack) report.alerts.push(`#${res.merged.pr} merged, but reading it back failed (${res.readBack}); confirmed merged from a fresh read`);
        // No sweep, reset or other PR after a lost lock or a merge command that may still run.
        if (await countMerge(ctx, report, res.merged, { lost: res.lost, stuck: res.stuck })) lost = true;
      }
    } catch (e) {
      // Settle the PR from a fresh read. A merge that went through gets the same decision as
      // any other (countMerge); anything else is reported as the error.
      const settled = settleAfterError(gh, pr, res, report, ctx.lock);
      if (!settled) throw e;
      res = settled;
      report.alerts.push(`#${pr.number} merged, but reading it back failed (${firstLine(e?.message || e)}); confirmed merged from a fresh read`);
      if (await countMerge(ctx, report, settled.merged, { recovered: true })) lost = true;
    } finally {
      if (!releaseLock(ctx, report)) lost = true;
    }
    if (!res) break;
    if (res.bounced) report.bounced.push(res.bounced);
    else if (res.aborted) {
      report.aborted.push(res.aborted);
      if (res.paused) report.paused = true;
      if (res.lost) { lost = true; report.alerts.push(`the landing lock was lost while landing #${res.aborted.pr}; stopped`); }
      // GitHub lagging behind a push: this run stops here; the next one picks the PR up again.
      if (res.stop) break;
    }
    if (report.paused || lost) break;
  }
  // A sweep that is overdue (merges by land-pr, or a run that stopped before its sweep) runs when
  // nothing else is in the way.
  if (!opts.dryRun && !report.paused && !report.busy && !report.stale.length && !lost && sweepDue(gh.repo, ctx.cfg) && !gh.isPaused()) {
    if (takeLock(ctx, report, opts)) {
      try { if (await sweepAfter(ctx, report)) lost = true; } finally { releaseLock(ctx, report); }
    }
  }
  fillQueueState(gh, report);
  return report;
}

async function unpauseRepo(t) {
  // Only the wide sweep runs here: the landing gate is not needed.
  const ctx = context(t, { needGate: false });
  const { gh, cfg } = ctx;
  if (!gh.isPaused()) return { repo: t.repo, paused: false, sweep: null, note: 'not paused' };
  // Nothing can show the base is green without a sweep: the pause stays for the owner to clear.
  if (!sweepCommands(cfg).length) return { repo: t.repo, paused: true, sweep: null, note: 'no wideSweep is configured, so nothing can show the base is green; the owner clears the pause' };
  let sweep = null;
  {
    // The sweep runs in the lander checkout: only while holding the landing lock.
    const probe = { stale: [], busy: false, alerts: [] };
    if (!takeLock(ctx, probe, {})) {
      return { repo: t.repo, paused: true, sweep: null, busy: true, note: probe.stale.length ? 'the landing lock is stale; the lander reclaims it' : 'the landing lock is busy; try again after the lander finishes' };
    }
    let r;
    // The pause is cleared while the lock is still held, after the green sweep: once the lock
    // is released, another lander's red sweep may set a new pause, which must not be cleared.
    let cleared = false;
    let clearError = null;
    try {
      r = await runSweep(ctx);
      sweep = { ok: r.ok, cmd: r.cmd, status: r.status };
      if (r.ok && !r.lost && !r.stuck && ctx.lock.stillHeld()) {
        try { gh.setPaused(false); cleared = true; } catch (e) { clearError = firstLine(e?.message || e); }
      } else if (r.ok && !r.lost && !r.stuck) {
        r = { ...r, ok: false, lost: true };
      }
    } finally {
      if (!releaseLock(ctx, probe)) process.stderr.write(`WARNING: ${probe.alerts.at(-1)}\n`);
    }
    if (r.lost) return { repo: t.repo, paused: true, sweep, note: 'the landing lock was lost during the sweep; the pause stays', lockRetained: probe.lockRetained || null };
    if (r.stuck || r.timedOut) return { repo: t.repo, paused: true, sweep, note: `wide sweep on ${cfg.base} did not finish (${r.summary}); the pause stays`, lockRetained: probe.lockRetained || null };
    if (!r.ok) return { repo: t.repo, paused: true, sweep, note: `wide sweep on ${cfg.base} is still red (${r.summary})`, lockRetained: probe.lockRetained || null };
    if (!cleared) return { repo: t.repo, paused: true, sweep, note: `the sweep is green, but the pause could not be cleared (${clearError}); clear it again with land-queue unpause`, lockRetained: probe.lockRetained || null };
  }
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
  for (const w of s.waiting) lines.push(`  waiting #${w.pr} on ${w.dependsOn.map(depName).join(', ')}`);
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
      if (cmd === 'run') {
        const r = await runRepo(t, { dryRun: Boolean(args['dry-run']), reclaimStale: Boolean(args['reclaim-stale']) });
        if (r.error) failed++;
        reports.push(r);
      }
      else if (cmd === 'status') reports.push(statusRepo(t));
      else reports.push(await unpauseRepo(t));
    } catch (e) {
      failed++;
      reports.push({ repo: t.repo, error: e instanceof LandError ? e.message : String(e?.message || e) });
    }
  }
  const text = (r) => {
    if (cmd === 'run' && r.merged) return `${runText(r)}${r.error ? `\n  ERROR ${r.error} (the run stopped here; the results above stand)` : ''}`;
    if (r.error) return `${r.repo}: ERROR ${r.error}`;
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
