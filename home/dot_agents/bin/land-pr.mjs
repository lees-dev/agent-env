// land-pr: the last step of every builder. Merge a gated PR now when it is safe and fair, else
// queue it for the repo's lander (land-queue.mjs). The rules: pr-workflow skill, section 4.
//
// Usage:
//   node land-pr.mjs <pr> --sha <gated-sha> [--release-hold] [--holder <id>] [--repo owner/name] [--json] [--dry-run]
//   node land-pr.mjs hold <pr> [--holder <id>] [--repo owner/name] [--json]
//
// Merge now: only when the gated head already contains origin/<base> AND no other PR in the repo
// is `queued`, `queue-waiting` or `landing` (fairness; held PRs count too). The landing lock
// (refs/heads/agent-landing-lock) is taken first; then the PR (state, head, base, branch), the
// refusals, the rest of the queue and the base are checked again, and last the labels, head,
// pause flag and lock ownership; then the merge is pinned to the gated head, the queue labels
// are cleared, a wide sweep that is due runs under the lock, and the lock is released only if it
// is still ours. A busy lock, a moved base or anyone else in line queues the PR instead.
// Queue: label `queued`, write a `## Landing` section (`Gate: pass @ <sha>`). Unheld `queued` +
// `landing` PRs count toward the repo's capacity (maxQueued, default 5). When it is full, or
// older PRs are already waiting, the PR gets `queue-waiting`; the lander admits it when a slot
// frees. A PR already `queued` only gets its gated sha refreshed. A `queue-waiting` PR stays
// waiting unless it is the oldest waiting PR and a slot is free. A `queue-blocked` PR (bounced,
// then fixed, re-gated and re-reviewed) goes back in line: queue-blocked -> queued (or
// queue-waiting). None of these is ever merged now.
// Editing a queued PR (pr-workflow section 4): `hold` adds `queue-hold` and a PR-body line
// `Hold-By: <holder> <ISO time>` in one edit. <holder> is --holder, else $T3CODE_THREAD_ID; with
// neither it refuses (exit 2), because the same id must release the hold. `hold` refuses when the
// PR is `landing` or `queue-hold` is already there, and backs its hold out again if `landing`
// appears meanwhile. After the push, gate and review, `--release-hold` (same holder) first runs
// the read-only checks (only its own queue-hold excepted), then records the new gated sha and
// removes `queue-hold` and this holder's line in one edit, then continues as above on a fresh
// read. A hold whose line names another holder is refused. Only whoever set a hold clears it
// (the owner may clear any by hand).
//
//   HELD <holder>           hold: queue-hold and the Hold-By line added                exit 0
//
// Prints one line (or JSON with --json):
//   MERGED <merge-sha>      merged now (or already merged)                         exit 0
//   QUEUED <position>       the lander will land it; kick the lander schedule        exit 0
//   QUEUE-FULL <position>   labelled queue-waiting; kick the lander schedule         exit 3
//   REFUSED <reason>        queue-hold, landing, unmerged Depends-on, the repo is paused
//                           (AGENT_LANDING_PAUSED=1), no holder id, or a hold this caller
//                           did not set: no merge, no label change                   exit 2
// Errors (head is not the gated sha, draft, closed, retargeted, merge failed, no gate in
// .agents/repo.json) exit 1 (a config error exits 2); bad usage exits 2.
import {
  Gh, LandError, LandingLock,
  addHold, baseTreeOf, bumpMergeCount, capacityUsed, captureToken, classifyQueue, dueSweep, fetchBranch, firstLine, gitOk,
  holderId, isAncestor, labelNames, listQueue, listWaiting, loadRepoConfig, mainCheckout, mergePinned, parseArgs, parseHolds,
  parseLanding, print, removeHold, repoTop, retainedLockMessage, setLabels, slugFromRemote, unmetDeps, writeLanding,
} from './lib/land.mjs';

const USAGE = [
  'usage: node land-pr.mjs <pr> --sha <gated-sha> [--release-hold] [--holder <id>] [--repo owner/name] [--json] [--dry-run]',
  '       node land-pr.mjs hold <pr> [--holder <id>] [--repo owner/name] [--json]',
].join('\n');

// Why land-pr must not merge or queue this PR; empty when it may proceed. ignoreHold: the
// caller is releasing its own (only) hold.
function refusal(gh, pr, { ignoreHold = false } = {}) {
  const labels = labelNames(pr);
  if (labels.includes('landing')) return 'landing (the lander is landing it now)';
  if (!ignoreHold && labels.includes('queue-hold')) return 'queue-hold (held by the owner, a full stop or an agent editing it)';
  const deps = unmetDeps(gh, pr);
  if (deps.length) return `Depends-on ${deps.map((d) => `#${d}`).join(', ')} not merged`;
  if (gh.isPaused()) return 'repo paused (AGENT_LANDING_PAUSED=1)';
  return '';
}

// Other PRs in line: queued, landing or queue-waiting (held ones included: fairness).
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
  // Read-only checks first, then the edit, then a re-check.
  const pr = gh.prView(n);
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  const labels = labelNames(pr);
  if (labels.includes('landing')) return refuse('landing (the lander has it; wait for its merge or bounce)');
  if (labels.includes('queue-hold')) return refuse('queue-hold already set (leave it, push nothing that lands, report it)');
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

async function main() {
  captureToken();
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

  // Release the caller's own hold and record the new gated sha in one edit. Every read-only
  // check runs first, whoever else holds the PR (only queue-hold itself is excepted; `landing`,
  // an unmerged Depends-on or a pause refuses with no edit at all); then the edit; then the
  // normal checks again on a fresh read.
  let released = false;
  if (args['release-hold']) {
    const holder = holderId(args.holder);
    const holds = parseHolds(pr.body);
    if (!holds.some((h) => h.holder === holder)) return refuse(`queue-hold was not set by ${holder} (no "Hold-By: ${holder} ..." line)`);
    const others = holds.filter((h) => h.holder !== holder);
    const why = refusal(gh, pr, { ignoreHold: true });
    if (why) return refuse(why);
    if (args['dry-run']) return out({ result: 'WOULD-RELEASE', pr: n, sha, line: 'WOULD-RELEASE' }, 0);
    const prev = parseLanding(pr.body);
    const inLine = labelNames(pr).some((l) => l === 'queued' || l === 'queue-waiting');
    const body = writeLanding(removeHold(pr.body, holder), { gateSha: sha, queuedAt: inLine && prev.queuedAt ? prev.queuedAt : new Date().toISOString() });
    if (others.length) {
      // Only the caller's own hold is released (its Hold-By line goes, the new gated sha is
      // recorded); queue-hold stays for the other holders, so REFUSED: nothing lands or queues.
      gh.prEdit(n, { body });
      return refuse(`queue-hold is still set by ${others.length} other holder(s); your hold line was removed and the gated sha recorded`);
    }
    const held = labelNames(pr).includes('queue-hold');
    gh.prEdit(n, { body, remove: held ? ['queue-hold'] : [] });
    released = true;
    pr = gh.prView(n);
    if (pr.state === 'MERGED') return mergedOut(pr);
    if (pr.headRefOid !== sha) throw new LandError(`PR #${n} head moved to ${pr.headRefOid} while releasing the hold; re-run the gate`);
  }

  const refused = refusal(gh, pr);
  if (refused) return refuse(refused);

  const labels = labelNames(pr);
  const queued = labels.includes('queued');
  const waitingNow = labels.includes('queue-waiting');
  const blocked = labels.includes('queue-blocked');
  const base = pr.baseRefName || cfg.base;
  const headRef = pr.headRefName;
  fetchBranch(root, base);
  const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);
  let line = othersInLine(gh, n);

  // Merge now: fair (nobody else in line), current, and not already in the queue system.
  let lockInfo = null;
  if (current && !queued && !waitingNow && !blocked && line.count === 0) {
    if (args['dry-run']) return out({ result: 'WOULD-MERGE', pr: n, sha, line: 'WOULD-MERGE' }, 0);
    const lock = new LandingLock(gh, { ttlMin: cfg.lockTtlMin, cwd: root });
    const got = lock.acquire(baseTreeOf(root, `refs/remotes/origin/${base}`));
    if (got.held) {
      try {
        // Under the lock, every fresh read of the PR gets every check, on that same object:
        // open, the gated head, the validated base and branch, and no refusal (hold, landing,
        // unmerged Depends-on, pause). Read, check the queue and the base, then read again
        // (the last read before the merge) and check the lock.
        const validate = (p) => {
          if (p.state === 'MERGED') return { done: mergedOut(p) };
          if (p.state !== 'OPEN') throw new LandError(`PR #${n} is ${p.state}`);
          if (p.headRefOid !== sha) throw new LandError(`PR #${n} head moved to ${p.headRefOid} while landing; re-run the gate`);
          if ((p.baseRefName || base) !== base || p.headRefName !== headRef) {
            throw new LandError(`PR #${n} now targets ${p.baseRefName} from ${p.headRefName}; re-run the gate and land-pr`);
          }
          const why = refusal(gh, p);
          return why ? { done: refuse(why) } : null;
        };
        pr = gh.prView(n);
        const firstRead = validate(pr);
        if (firstRead) return firstRead.done;
        line = othersInLine(gh, n);
        fetchBranch(root, base);
        const stillCurrent = isAncestor(`refs/remotes/origin/${base}`, sha, root);
        let fair = false;
        if (stillCurrent && line.count === 0) {
          const lastRead = validate(gh.prView(n));
          if (lastRead) return lastRead.done;
          // Fairness once more, after the last read: a PR queued meanwhile goes first.
          line = othersInLine(gh, n);
          fair = line.count === 0;
        }
        if (fair) {
          if (!lock.stillHeld()) throw new LandError('the landing lock was lost before the merge; run land-pr again');
          const m = mergePinned(gh, cfg, { pr: n, sha, cwd: root });
          if (!m.ok) throw new LandError(`merge of #${n} failed: ${m.message}`);
          bumpMergeCount(repo);
          // A wide sweep that is due runs now, still under the lock.
          let sweep = null;
          try {
            sweep = await dueSweep({ gh, cfg, mainRoot: mainCheckout(root), lock });
            if (sweep?.alert) process.stderr.write(`warning: ${sweep.alert}\n`);
          } catch (e) {
            sweep = { ran: false, ok: false, error: firstLine(e?.message || e) };
            process.stderr.write(`warning: the wide sweep could not run: ${sweep.error}\n`);
          }
          const freed = lock.release();
          if (!freed) process.stderr.write(`WARNING: ${retainedLockMessage(lock)}\n`);
          return out({ result: 'MERGED', pr: n, sha, mergeSha: m.mergeSha, released, sweep, lockRetained: freed ? null : lock.retained, line: `MERGED ${m.mergeSha || ''}`.trim() }, 0);
        }
      } finally {
        if (!lock.release()) process.stderr.write(`WARNING: ${retainedLockMessage(lock)}\n`);
      }
    } else {
      lockInfo = { busy: true, stale: got.stale, holder: got.holder ? { host: got.holder.host, pid: got.holder.pid, ageMin: got.holder.ageMin } : null };
    }
  }

  // Queue it, or refresh the gated sha of a PR already in line. Held PRs do not use capacity.
  const room = capacityUsed(line.active) < cfg.maxQueued;
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

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`land-pr: ${e instanceof LandError ? e.message : e?.stack || e}\n`);
  process.exitCode = e instanceof LandError ? e.code : 1;
});
