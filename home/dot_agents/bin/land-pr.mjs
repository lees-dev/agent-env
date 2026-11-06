// land-pr: the last step of every builder. Merge a gated PR now when it is safe, else queue it
// for the repo's lander (land-queue.mjs).
//
// Usage: node land-pr.mjs <pr> --sha <gated-sha> [--repo owner/name] [--json] [--dry-run]
//
// Merge now: only when the gated head already contains origin/<base>. The landing lock
// (refs/heads/agent-landing-lock) is taken first; then the base, the PR's labels and head and the
// repo pause flag are checked again; then the merge is pinned to the gated head; the lock is
// released only if it is still ours. A busy lock or a moved base queues the PR instead.
// Queue: label `queued`, write a `## Landing` section (`Gate: pass @ <sha>`). `queued` + `landing`
// PRs count toward the repo's capacity (maxQueued, default 5); at capacity the PR gets
// `queue-waiting` and the lander admits it when a slot frees. A PR already queued or waiting only
// gets its gated sha refreshed; it is never merged now. A `queue-blocked` PR (bounced, then fixed,
// re-gated and re-reviewed) goes back in line: queue-blocked -> queued (or queue-waiting when
// full) with the new gated sha; it is never merged now either. `queue-hold` always refuses; only
// whoever set it clears it (the owner may clear any).
//
// Prints one line (or JSON with --json):
//   MERGED <merge-sha>      merged now (or already merged)                         exit 0
//   QUEUED <position>       the lander will land it; kick the lander schedule        exit 0
//   QUEUE-FULL <position>   labelled queue-waiting; nothing else to do               exit 3
//   REFUSED <reason>        queue-hold, landing, unmerged Depends-on, or the repo is
//                           paused (AGENT_LANDING_PAUSED=1): no merge, no label change exit 2
// Errors (head is not the gated sha, draft, closed, merge failed) exit 1; bad usage exits 2.
import {
  Gh, LandError, LandingLock,
  baseTreeOf, bumpMergeCount, classifyQueue, fetchBranch, gitOk, isAncestor, labelNames, listQueue, listWaiting,
  loadRepoConfig, mergePinned, parseArgs, parseLanding, print, repoTop, setLabels, slugFromRemote, unmetDeps, writeLanding,
} from './lib/land.mjs';

const USAGE = 'usage: node land-pr.mjs <pr> --sha <gated-sha> [--repo owner/name] [--json] [--dry-run]';

// Why land-pr must not merge or queue this PR; empty when it may proceed.
function refusal(gh, pr) {
  const labels = labelNames(pr);
  if (labels.includes('queue-hold')) return 'queue-hold (held by the owner or a full stop)';
  if (labels.includes('landing')) return 'landing (the lander is landing it now)';
  const deps = unmetDeps(gh, pr);
  if (deps.length) return `Depends-on ${deps.map((d) => `#${d}`).join(', ')} not merged`;
  if (gh.isPaused()) return 'repo paused (AGENT_LANDING_PAUSED=1)';
  return '';
}

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: new Set(['json', 'dry-run', 'help']), options: new Set(['sha', 'repo']) });
  if (args.help) { print(USAGE, false); return 0; }
  const n = Number(args._[0]);
  if (!Number.isInteger(n) || n <= 0 || !args.sha) throw new LandError(USAGE, 2);

  const root = repoTop();
  const cfg = loadRepoConfig(root);
  const repo = args.repo || slugFromRemote(root);
  if (!repo) throw new LandError('cannot tell the GitHub repo from origin; pass --repo owner/name', 2);
  const gh = new Gh({ repo });
  const out = (o, code) => { if (args.json) print(o, true); else print(o.line, false); return code; };
  const mergedOut = (p) => out({ result: 'MERGED', pr: n, mergeSha: p.mergeCommit?.oid || null, already: true, line: `MERGED ${p.mergeCommit?.oid || ''}`.trim() }, 0);

  let pr = gh.prView(n);
  if (pr.state === 'MERGED') return mergedOut(pr);
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  if (pr.isDraft) throw new LandError(`PR #${n} is a draft: mark it ready first`);
  const sha = gitOk(['rev-parse', '--verify', `${args.sha}^{commit}`], { cwd: root });
  if (pr.headRefOid !== sha) {
    throw new LandError(`PR #${n} head is ${pr.headRefOid}, the gated sha is ${sha}: push the gated commit or re-run the gate on the PR head`);
  }

  const refused = refusal(gh, pr);
  if (refused) return out({ result: 'REFUSED', pr: n, reason: refused, line: `REFUSED ${refused}` }, 2);

  const labels = labelNames(pr);
  const already = labels.includes('queued') || labels.includes('queue-waiting');
  const blocked = labels.includes('queue-blocked');
  const base = pr.baseRefName || cfg.base;
  fetchBranch(root, base);
  const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);

  // Merge now: lock first, then check the base, the PR and the pause flag again under the lock.
  let lockInfo = null;
  if (current && !already && !blocked) {
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
        if (again) return out({ result: 'REFUSED', pr: n, reason: again, line: `REFUSED ${again}` }, 2);
        if (stillCurrent) {
          const m = mergePinned(gh, cfg, { pr: n, sha });
          if (!m.ok) throw new LandError(`merge of #${n} failed: ${m.message}`);
          bumpMergeCount(repo);
          return out({ result: 'MERGED', pr: n, sha, mergeSha: m.mergeSha, line: `MERGED ${m.mergeSha || ''}`.trim() }, 0);
        }
      } finally {
        lock.release();
      }
    } else {
      lockInfo = { busy: true, stale: got.stale, holder: got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null };
    }
  }

  // Queue it, or refresh the gated sha of a PR that is already queued or waiting.
  const active = listQueue(gh).filter((p) => p.number !== n);
  const full = labels.includes('queue-waiting') || (!labels.includes('queued') && active.length >= cfg.maxQueued);
  if (args['dry-run']) {
    const r = full ? 'WOULD-WAIT' : 'WOULD-QUEUE';
    return out({ result: r, pr: n, sha, current, requeue: blocked, lock: lockInfo, line: r }, 0);
  }

  gh.ensureLabels();
  const prev = parseLanding(pr.body);
  const queuedAt = already && prev.queuedAt ? prev.queuedAt : new Date().toISOString();
  const body = writeLanding(pr.body, { gateSha: sha, queuedAt });
  if (body !== pr.body) { gh.prEdit(n, { body }); pr.body = body; }
  if (lockInfo?.stale) process.stderr.write(`warning: the landing lock is stale (${lockInfo.holder?.ageMin} min); the lander decides whether to reclaim it\n`);

  if (full) {
    setLabels(gh, pr, { add: ['queue-waiting'], remove: ['queue-blocked'] });
    const waiting = listWaiting(gh);
    const idx = waiting.findIndex((p) => p.number === n);
    const position = active.length + (idx >= 0 ? idx + 1 : waiting.length + 1);
    return out({ result: 'QUEUE-FULL', pr: n, sha, position, capacity: cfg.maxQueued, refreshed: already, requeue: blocked, lock: lockInfo, line: `QUEUE-FULL ${position}` }, 3);
  }
  setLabels(gh, pr, { add: ['queued'], remove: ['queue-blocked'] });
  const { eligible, waiting } = classifyQueue(gh, listQueue(gh));
  let position = eligible.findIndex((p) => p.number === n) + 1;
  if (position === 0) position = eligible.length + waiting.length;
  return out({ result: 'QUEUED', pr: n, sha, position, refreshed: already, requeue: blocked, current, lock: lockInfo, line: `QUEUED ${position}` }, 0);
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
