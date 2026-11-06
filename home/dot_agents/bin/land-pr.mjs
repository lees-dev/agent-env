// land-pr: the last step of every builder. Merge a gated PR now when it is safe, else queue it
// for the repo's lander (land-queue.mjs).
//
// Usage: node land-pr.mjs <pr> --sha <gated-sha> [--repo owner/name] [--json] [--dry-run]
//
// Merges now when the gated head already contains origin/<base> and no lander holds the
// repo's landing lock (refs/heads/agent-landing-lock). Otherwise labels the PR `queued`, writes
// a `## Landing` section (`Gate: pass @ <sha>`) in its body, and prints its queue position.
//
// Prints one of:
//   MERGED <merge-sha>     merged now (or already merged)
//   QUEUED <position>      the lander will land it; kick the lander schedule
//   HELD                   the PR has queue-hold (full stop): nothing was merged or queued
// Exit: 0 on those, 1 on an error (head moved, draft, closed, merge failed), 2 on bad usage.
import {
  Gh, LandError, LandingLock, MAX_QUEUED_HINT,
  baseTreeOf, bumpMergeCount, classifyQueue, fetchBranch, gitOk, isAncestor, labelNames, listQueue,
  loadRepoConfig, mergePinned, parseArgs, parseLanding, print, repoTop, setLabels, slugFromRemote, writeLanding,
} from './lib/land.mjs';

const USAGE = 'usage: node land-pr.mjs <pr> --sha <gated-sha> [--repo owner/name] [--json] [--dry-run]';

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
  const out = (o) => (args.json ? print(o, true) : print(o.line, false));

  let pr = gh.prView(n);
  if (pr.state === 'MERGED') {
    out({ result: 'MERGED', pr: n, mergeSha: pr.mergeCommit?.oid || null, already: true, line: `MERGED ${pr.mergeCommit?.oid || ''}`.trim() });
    return 0;
  }
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  if (pr.isDraft) throw new LandError(`PR #${n} is a draft: mark it ready first`);

  const sha = gitOk(['rev-parse', '--verify', `${args.sha}^{commit}`], { cwd: root });
  if (pr.headRefOid !== sha) {
    throw new LandError(`PR #${n} head is ${pr.headRefOid}, the gated sha is ${sha}: push the gated commit or re-run the gate on the PR head`);
  }

  if (labelNames(pr).includes('queue-hold')) {
    out({ result: 'HELD', pr: n, line: 'HELD' });
    return 0;
  }

  const base = pr.baseRefName || cfg.base;
  fetchBranch(root, base);
  const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);

  let lockInfo = null;
  if (current) {
    if (args['dry-run']) { out({ result: 'WOULD-MERGE', pr: n, sha, line: 'WOULD-MERGE' }); return 0; }
    const lock = new LandingLock(gh, { ttlMin: cfg.lockTtlMin });
    const got = lock.acquire(baseTreeOf(root, `refs/remotes/origin/${base}`));
    if (got.held) {
      try {
        // The base may have moved between the fetch and the lock.
        fetchBranch(root, base);
        if (isAncestor(`refs/remotes/origin/${base}`, sha, root)) {
          const m = mergePinned(gh, cfg, { pr: n, sha });
          if (!m.ok) throw new LandError(`merge of #${n} failed: ${m.message}`);
          bumpMergeCount(repo);
          out({ result: 'MERGED', pr: n, sha, mergeSha: m.mergeSha, line: `MERGED ${m.mergeSha || ''}`.trim() });
          return 0;
        }
      } finally {
        lock.release();
      }
    } else {
      lockInfo = { busy: true, stale: got.stale, holder: got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null };
    }
  }

  if (args['dry-run']) { out({ result: 'WOULD-QUEUE', pr: n, sha, current, lock: lockInfo, line: 'WOULD-QUEUE' }); return 0; }

  // Queue it.
  gh.ensureLabels();
  const prev = parseLanding(pr.body);
  const wasQueued = labelNames(pr).some((l) => l === 'queued' || l === 'landing');
  const queuedAt = wasQueued && prev.queuedAt ? prev.queuedAt : new Date().toISOString();
  const body = writeLanding(pr.body, { gateSha: sha, queuedAt });
  if (body !== pr.body) gh.prEdit(n, { body });
  setLabels(gh, pr, { add: ['queued'], remove: ['queue-blocked'] });

  const { eligible, waiting } = classifyQueue(gh, listQueue(gh));
  let position = eligible.findIndex((p) => p.number === n) + 1;
  const wait = waiting.find((w) => w.pr === n);
  if (position === 0) position = eligible.length + 1;
  const total = eligible.length + waiting.length;
  if (total > MAX_QUEUED_HINT) process.stderr.write(`warning: ${total} PRs queued in ${repo} (more than ${MAX_QUEUED_HINT}); the lander may be stuck\n`);
  if (lockInfo?.stale) process.stderr.write(`warning: the landing lock is stale (${lockInfo.holder?.ageMin} min); the lander decides whether to reclaim it\n`);
  out({ result: 'QUEUED', pr: n, sha, position, waitingOn: wait ? wait.dependsOn : [], current, lock: lockInfo, line: `QUEUED ${position}` });
  return 0;
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
