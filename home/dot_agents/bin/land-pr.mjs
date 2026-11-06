// land-pr: the last step of every builder. Merge a gated PR now when it is safe and fair, else
// queue it for the repo's lander (land-queue.mjs). The rules: pr-workflow skill, section 4.
//
// Usage:
//   node land-pr.mjs <pr> --sha <gated-sha> [--release-hold] [--holder <id>] [--repo owner/name] [--json] [--dry-run]
//   node land-pr.mjs hold <pr> [--holder <id>] [--repo owner/name] [--json]
//
// Merge now: only when the gated head already contains origin/<base> AND no other PR in the repo
// is `queued`, `queue-waiting` or `landing` (fairness). The landing lock
// (refs/heads/agent-landing-lock) is taken first; then the base, the PR's labels and head, the
// rest of the queue and the repo pause flag are checked again; then the merge is pinned to the
// gated head; the lock is released only if it is still ours. A busy lock, a moved base or anyone
// else in line queues the PR instead.
// Queue: label `queued`, write a `## Landing` section (`Gate: pass @ <sha>`). `queued` + `landing`
// PRs count toward the repo's capacity (maxQueued, default 5). When it is full, or older PRs are
// already waiting, the PR gets `queue-waiting`; the lander admits it when a slot frees. A PR
// already `queued` only gets its gated sha refreshed. A `queue-waiting` PR stays waiting unless it
// is the oldest waiting PR and a slot is free. A `queue-blocked` PR (bounced, then fixed, re-gated
// and re-reviewed) goes back in line: queue-blocked -> queued (or queue-waiting). None of these
// is ever merged now.
// Editing a queued PR (pr-workflow section 4): `hold` adds `queue-hold` and a PR-body line
// `Hold-By: <holder> <ISO time>` in one edit. <holder> is --holder, else $T3CODE_THREAD_ID, else
// `<hostname>:<parent pid>`. It refuses (exit 2) when `queue-hold` is already there or the PR is
// `landing`, and backs its hold out again if `landing` appears meanwhile. After the push, gate and
// review, `--release-hold` records the new gated sha and removes `queue-hold` and this holder's
// line in one edit, then continues as above. A hold whose line names another holder is refused.
// Only whoever set a hold clears it (the owner may clear any by hand).
//
//   HELD <holder>           hold: queue-hold and the Hold-By line added                exit 0
//
// Prints one line (or JSON with --json):
//   MERGED <merge-sha>      merged now (or already merged)                         exit 0
//   QUEUED <position>       the lander will land it; kick the lander schedule        exit 0
//   QUEUE-FULL <position>   labelled queue-waiting; kick the lander schedule         exit 3
//   REFUSED <reason>        queue-hold, landing, unmerged Depends-on, the repo is paused
//                           (AGENT_LANDING_PAUSED=1), or a hold this caller did not set:
//                           no merge, no label change                                exit 2
// Errors (head is not the gated sha, draft, closed, merge failed) exit 1; bad usage exits 2.
import {
  Gh, LandError, LandingLock,
  addHold, baseTreeOf, bumpMergeCount, classifyQueue, fetchBranch, gitOk, holderId, isAncestor, labelNames, listQueue,
  listWaiting, loadRepoConfig, mergePinned, parseArgs, parseHolds, parseLanding, print, removeHold, repoTop, setLabels,
  slugFromRemote, unmetDeps, writeLanding,
} from './lib/land.mjs';

const USAGE = [
  'usage: node land-pr.mjs <pr> --sha <gated-sha> [--release-hold] [--holder <id>] [--repo owner/name] [--json] [--dry-run]',
  '       node land-pr.mjs hold <pr> [--holder <id>] [--repo owner/name] [--json]',
].join('\n');

// Why land-pr must not merge or queue this PR; empty when it may proceed.
function refusal(gh, pr) {
  const labels = labelNames(pr);
  if (labels.includes('queue-hold')) return 'queue-hold (held by the owner, a full stop or an agent editing it)';
  if (labels.includes('landing')) return 'landing (the lander is landing it now)';
  const deps = unmetDeps(gh, pr);
  if (deps.length) return `Depends-on ${deps.map((d) => `#${d}`).join(', ')} not merged`;
  if (gh.isPaused()) return 'repo paused (AGENT_LANDING_PAUSED=1)';
  return '';
}

// Other PRs in line: queued, landing or queue-waiting.
function othersInLine(gh, n) {
  const active = listQueue(gh).filter((p) => p.number !== n);
  const waiting = listWaiting(gh).filter((p) => p.number !== n);
  return { active, waiting, count: active.length + waiting.length };
}

// land-pr hold <n>: add this holder's queue-hold and Hold-By line in one edit.
function hold(args, n) {
  const holder = holderId(args.holder);
  const root = repoTop();
  const repo = args.repo || slugFromRemote(root);
  if (!repo) throw new LandError('cannot tell the GitHub repo from origin; pass --repo owner/name', 2);
  const gh = new Gh({ repo });
  const out = (o, code) => { if (args.json) print(o, true); else print(o.line, false); return code; };
  const refuse = (reason) => out({ result: 'REFUSED', pr: n, reason, line: `REFUSED ${reason}` }, 2);
  const pr = gh.prView(n);
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  const labels = labelNames(pr);
  if (labels.includes('queue-hold')) return refuse('queue-hold already set (leave it, push nothing that lands, report it)');
  if (labels.includes('landing')) return refuse('landing (the lander has it; wait for its merge or bounce)');
  gh.ensureLabels();
  const body = addHold(pr.body, holder);
  gh.prEdit(n, { body, add: ['queue-hold'] });
  // The lander may have taken it in the meantime: then back out and wait.
  const after = gh.prView(n);
  if (labelNames(after).includes('landing')) {
    gh.prEdit(n, { body: removeHold(after.body, holder), remove: ['queue-hold'] });
    return refuse('landing (the lander took it while holding; hold removed, wait for its merge or bounce)');
  }
  return out({ result: 'HELD', pr: n, holder, line: `HELD ${holder}` }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: new Set(['json', 'dry-run', 'help', 'release-hold']), options: new Set(['sha', 'repo', 'holder']) });
  if (args.help) { print(USAGE, false); return 0; }
  if (args._[0] === 'hold') {
    const h = Number(args._[1]);
    if (!Number.isInteger(h) || h <= 0) throw new LandError(USAGE, 2);
    return hold(args, h);
  }
  const n = Number(args._[0]);
  if (!Number.isInteger(n) || n <= 0 || !args.sha) throw new LandError(USAGE, 2);

  const root = repoTop();
  const cfg = loadRepoConfig(root);
  const repo = args.repo || slugFromRemote(root);
  if (!repo) throw new LandError('cannot tell the GitHub repo from origin; pass --repo owner/name', 2);
  const gh = new Gh({ repo });
  const out = (o, code) => { if (args.json) print(o, true); else print(o.line, false); return code; };
  const refuse = (reason) => out({ result: 'REFUSED', pr: n, reason, line: `REFUSED ${reason}` }, 2);
  const mergedOut = (p) => out({ result: 'MERGED', pr: n, mergeSha: p.mergeCommit?.oid || null, already: true, line: `MERGED ${p.mergeCommit?.oid || ''}`.trim() }, 0);

  let pr = gh.prView(n);
  if (pr.state === 'MERGED') return mergedOut(pr);
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  if (pr.isDraft) throw new LandError(`PR #${n} is a draft: mark it ready first`);
  const sha = gitOk(['rev-parse', '--verify', `${args.sha}^{commit}`], { cwd: root });
  if (pr.headRefOid !== sha) {
    throw new LandError(`PR #${n} head is ${pr.headRefOid}, the gated sha is ${sha}: push the gated commit or re-run the gate on the PR head`);
  }

  // Release the caller's own hold and record the new gated sha in one edit.
  let released = false;
  if (args['release-hold']) {
    const holder = holderId(args.holder);
    if (!parseHolds(pr.body).some((h) => h.holder === holder)) return refuse(`queue-hold was not set by ${holder} (no "Hold-By: ${holder} ..." line)`);
    if (args['dry-run']) return out({ result: 'WOULD-RELEASE', pr: n, sha, line: 'WOULD-RELEASE' }, 0);
    const prev = parseLanding(pr.body);
    const inLine = labelNames(pr).some((l) => l === 'queued' || l === 'queue-waiting');
    const body = writeLanding(removeHold(pr.body, holder), { gateSha: sha, queuedAt: inLine && prev.queuedAt ? prev.queuedAt : new Date().toISOString() });
    const others = parseHolds(body);
    if (others.length) {
      gh.prEdit(n, { body });
      return refuse(`queue-hold is still set by ${others.length} other holder(s)`);
    }
    const hold = labelNames(pr).includes('queue-hold');
    gh.prEdit(n, { body, remove: hold ? ['queue-hold'] : [] });
    pr.body = body;
    pr.labels = labelNames(pr).filter((l) => l !== 'queue-hold').map((name) => ({ name }));
    released = true;
  }

  const refused = refusal(gh, pr);
  if (refused) return refuse(refused);

  const labels = labelNames(pr);
  const queued = labels.includes('queued');
  const waitingNow = labels.includes('queue-waiting');
  const blocked = labels.includes('queue-blocked');
  const base = pr.baseRefName || cfg.base;
  fetchBranch(root, base);
  const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);
  let line = othersInLine(gh, n);

  // Merge now: fair (nobody else in line), current, and not already in the queue system.
  let lockInfo = null;
  if (current && !queued && !waitingNow && !blocked && line.count === 0) {
    if (args['dry-run']) return out({ result: 'WOULD-MERGE', pr: n, sha, line: 'WOULD-MERGE' }, 0);
    const lock = new LandingLock(gh, { ttlMin: cfg.lockTtlMin });
    const got = lock.acquire(baseTreeOf(root, `refs/remotes/origin/${base}`));
    if (got.held) {
      try {
        fetchBranch(root, base);
        const stillCurrent = isAncestor(`refs/remotes/origin/${base}`, sha, root);
        pr = gh.prView(n);
        if (pr.state === 'MERGED') return mergedOut(pr);
        if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
        if (pr.headRefOid !== sha) throw new LandError(`PR #${n} head moved to ${pr.headRefOid} while landing; re-run the gate`);
        const again = refusal(gh, pr);
        if (again) return refuse(again);
        line = othersInLine(gh, n);
        if (stillCurrent && line.count === 0) {
          const m = mergePinned(gh, cfg, { pr: n, sha });
          if (!m.ok) throw new LandError(`merge of #${n} failed: ${m.message}`);
          bumpMergeCount(repo);
          return out({ result: 'MERGED', pr: n, sha, mergeSha: m.mergeSha, released, line: `MERGED ${m.mergeSha || ''}`.trim() }, 0);
        }
      } finally {
        lock.release();
      }
    } else {
      lockInfo = { busy: true, stale: got.stale, holder: got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null };
    }
  }

  // Queue it, or refresh the gated sha of a PR already in line.
  const room = line.active.length < cfg.maxQueued;
  const olderWaiting = line.waiting.length > 0;
  let full;
  if (queued) full = false;
  else if (waitingNow) full = !(room && listWaiting(gh)[0]?.number === n);
  else full = !room || olderWaiting;
  const r0 = full ? 'WOULD-WAIT' : 'WOULD-QUEUE';
  if (args['dry-run']) return out({ result: r0, pr: n, sha, current, requeue: blocked, lock: lockInfo, line: r0 }, 0);

  gh.ensureLabels();
  const prev = parseLanding(pr.body);
  const queuedAt = (queued || waitingNow) && prev.queuedAt ? prev.queuedAt : new Date().toISOString();
  const body = writeLanding(pr.body, { gateSha: sha, queuedAt });
  if (body !== pr.body) { gh.prEdit(n, { body }); pr.body = body; }
  if (lockInfo?.stale) process.stderr.write(`warning: the landing lock is stale (${lockInfo.holder?.ageMin} min); only the lander reclaims it\n`);
  const common = { pr: n, sha, refreshed: queued || waitingNow, requeue: blocked, released, current, lock: lockInfo };

  if (full) {
    setLabels(gh, pr, { add: ['queue-waiting'], remove: ['queue-blocked'] });
    const waiting = listWaiting(gh);
    const idx = waiting.findIndex((p) => p.number === n);
    const position = line.active.length + (idx >= 0 ? idx + 1 : waiting.length + 1);
    return out({ result: 'QUEUE-FULL', ...common, position, capacity: cfg.maxQueued, line: `QUEUE-FULL ${position}` }, 3);
  }
  setLabels(gh, pr, { add: ['queued'], remove: ['queue-blocked', 'queue-waiting'] });
  const { eligible, waiting } = classifyQueue(gh, listQueue(gh));
  let position = eligible.findIndex((p) => p.number === n) + 1;
  if (position === 0) position = eligible.length + waiting.length;
  return out({ result: 'QUEUED', ...common, position, line: `QUEUED ${position}` }, 0);
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof LandError) {
    process.stderr.write(`land-pr: ${e.message}\n`);
    process.exitCode = e.code;
  } else {
    process.stderr.write(`land-pr: ${e?.stack || e}\n`);
    process.exitCode = 1;
  }
}
