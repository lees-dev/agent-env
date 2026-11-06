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
// is still ours. A moved base or anyone else in line queues the PR instead. Every change to the
// PR (release-hold, merge, queue) is made under the landing lock on a fresh read; land-pr waits
// up to 10 min for a busy lock, then refuses with nothing changed (a stale lock refuses at once).
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
// PR is `landing` or `queue-hold` is already there, and makes its edit under the landing lock
// (a busy lock refuses too, with no edit). After the push, gate and review, `--release-hold` (same holder) first runs
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
  parseLanding, pollMs, print, removeHold, repoTop, retainedLockMessage, setLabels, slugFromRemote, unmetDeps,
  validateLandingCommands, writeLanding,
} from './lib/land.mjs';
import { sleepMs } from './lib/proc.mjs';

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

// Whether queue-hold was removed from PR n at or after `at` (the caller's Hold-By time, less a
// minute for clock skew), from the issue events. null when that cannot be told.
function holdRemovedSince(gh, n, at) {
  const since = Date.parse(at || '');
  if (!Number.isFinite(since)) return null;
  for (let page = 1; page <= 20; page++) {
    const r = gh.api('GET', `repos/${gh.repo}/issues/${n}/events?per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    if (r.data.some((e) => e?.event === 'unlabeled' && e?.label?.name === 'queue-hold' && Date.parse(e.created_at || '') >= since - 60000)) return true;
    if (r.data.length < 100) return false;
  }
  return null;
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
  const check = (p) => {
    if (p.state !== 'OPEN') throw new LandError(`PR #${n} is ${p.state}`);
    const labels = labelNames(p);
    if (labels.includes('landing')) return 'landing (the lander has it; wait for its merge or bounce)';
    if (labels.includes('queue-hold')) return 'queue-hold already set (leave it, push nothing that lands, report it)';
    return '';
  };
  // Read-only checks first.
  const first = check(gh.prView(n));
  if (first) return refuse(first);
  // The edit happens under the landing lock: the lander changes PR bodies and labels only while
  // holding it, and GitHub keeps the last body written, so this is what stops a bounce from
  // overwriting the Hold-By line. A busy lock refuses, with no edit, like `landing` does.
  const cfg = loadRepoConfig(root, { needGate: false });
  fetchBranch(root, cfg.base);
  const lock = new LandingLock(gh, { ttlMin: cfg.lockTtlMin, cwd: root });
  const got = lock.acquire(baseTreeOf(root, `refs/remotes/origin/${cfg.base}`));
  if (!got.held) {
    return refuse(`the landing lock is ${got.stale ? 'stale (only the lander reclaims it)' : 'busy (a landing is in progress)'}; try again after it`);
  }
  try {
    const pr = gh.prView(n);
    const again = check(pr);
    if (again) return refuse(again);
    gh.ensureLabels();
    gh.prEdit(n, { body: addHold(pr.body, holder), add: ['queue-hold'] });
    const after = gh.prView(n);
    if (!parseHolds(after.body).some((h) => h.holder === holder) || !labelNames(after).includes('queue-hold')) {
      throw new LandError(`PR #${n}: the hold was not recorded (Hold-By line or queue-hold missing after the edit); check the PR by hand`);
    }
    return out({ result: 'HELD', pr: n, holder, line: `HELD ${holder}` }, 0);
  } finally {
    if (!lock.release()) process.stderr.write(`WARNING: ${retainedLockMessage(lock)}\n`);
  }
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

  // Read-only checks first, with no lock: nothing is changed by a refusal.
  if (args['release-hold']) {
    const holder = holderId(args.holder);
    if (!parseHolds(pr.body).some((h) => h.holder === holder)) return refuse(`queue-hold was not set by ${holder} (no "Hold-By: ${holder} ..." line)`);
    const why = refusal(gh, pr, { ignoreHold: true });
    if (why) return refuse(why);
    if (args['dry-run']) return out({ result: 'WOULD-RELEASE', pr: n, sha, line: 'WOULD-RELEASE' }, 0);
  } else {
    const why = refusal(gh, pr);
    if (why) return refuse(why);
  }
  if (args['dry-run']) {
    const labels = labelNames(pr);
    const base = pr.baseRefName || cfg.base;
    fetchBranch(root, base);
    const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);
    const line = othersInLine(gh, n);
    if (current && !['queued', 'queue-waiting', 'queue-blocked'].some((l) => labels.includes(l)) && line.count === 0) {
      return out({ result: 'WOULD-MERGE', pr: n, sha, line: 'WOULD-MERGE' }, 0);
    }
    const r0 = queueFull(gh, cfg, n, labels, line) ? 'WOULD-WAIT' : 'WOULD-QUEUE';
    return out({ result: r0, pr: n, sha, current, requeue: labels.includes('queue-blocked'), line: r0 }, 0);
  }
  // Every change to the PR (releasing the hold, merging, queueing) happens under the landing
  // lock, on a fresh read: the lander changes PR bodies only while holding it, and GitHub keeps
  // the last body written, so an edit made outside the lock could drop the lander's lines. A
  // lock that stays busy (or is stale) refuses with nothing changed.
  validateLandingCommands(cfg, { gate: false });
  fetchBranch(root, cfg.base);
  const lock = new LandingLock(gh, { ttlMin: cfg.lockTtlMin, cwd: root });
  const got = acquireWaiting(lock, root, cfg.base);
  if (!got.held) {
    return refuse(got.stale
      ? `the landing lock is stale (${got.holder?.ageMin} min); only the lander reclaims it; nothing was changed`
      : `the landing lock stayed busy (a landing is in progress); run land-pr again after it; nothing was changed`);
  }
  try {
    return await underLock({ args, n, sha, cfg, root, repo, gh, lock, out, refuse, mergedOut });
  } finally {
    if (!lock.release()) process.stderr.write(`WARNING: ${retainedLockMessage(lock)}\n`);
  }
}

// Take the landing lock, waiting (bounded) while another lander or land-pr holds it: the lander
// releases it between PRs. AGENT_LAND_LOCK_WAIT_MS overrides the 10 min for tests.
function acquireWaiting(lock, root, base) {
  const v = Number(process.env.AGENT_LAND_LOCK_WAIT_MS);
  const until = Date.now() + (Number.isFinite(v) && v >= 0 ? v : 10 * 60000);
  for (;;) {
    const got = lock.acquire(baseTreeOf(root, `refs/remotes/origin/${base}`));
    if (got.held || got.stale || Date.now() >= until) return got;
    sleepMs(Math.max(5, pollMs() * 5));
    fetchBranch(root, base);
  }
}

// Whether a PR that is not merged now goes to queue-waiting (no room, or older PRs waiting).
function queueFull(gh, cfg, n, labels, line) {
  if (labels.includes('queued')) return false;
  const room = capacityUsed(line.active) < cfg.maxQueued;
  if (labels.includes('queue-waiting')) return !(room && listWaiting(gh)[0]?.number === n);
  return !room || line.waiting.length > 0;
}

async function underLock({ args, n, sha, cfg, root, repo, gh, lock, out, refuse, mergedOut }) {
  // The same PR as checked before the lock.
  let pr = gh.prView(n);
  if (pr.state === 'MERGED') return mergedOut(pr);
  if (pr.state !== 'OPEN') throw new LandError(`PR #${n} is ${pr.state}`);
  if (pr.headRefOid !== sha) throw new LandError(`PR #${n} head moved to ${pr.headRefOid}; re-run the gate`);

  // Release the caller's own hold and record the new gated sha in one edit. Every check runs
  // again on this fresh read first (only queue-hold itself is excepted; `landing`, an unmerged
  // Depends-on or a pause refuses with no edit at all).
  let released = false;
  if (args['release-hold']) {
    const holder = holderId(args.holder);
    const holds = parseHolds(pr.body);
    const mine = holds.find((h) => h.holder === holder);
    if (!mine) return refuse(`queue-hold was not set by ${holder} (no "Hold-By: ${holder} ..." line)`);
    const others = holds.filter((h) => h.holder !== holder);
    const why = refusal(gh, pr, { ignoreHold: true });
    if (why) return refuse(why);
    const prev = parseLanding(pr.body);
    const inLine = labelNames(pr).some((l) => l === 'queued' || l === 'queue-waiting');
    const body = writeLanding(removeHold(pr.body, holder), { gateSha: sha, queuedAt: inLine && prev.queuedAt ? prev.queuedAt : new Date().toISOString() });
    // The label is the caller's only while nobody removed it since the caller's hold: a removal
    // after that (the owner cleared it, maybe set it again) makes the current label someone
    // else's. Unknown (the timeline cannot be read) counts as someone else's.
    const relabelled = labelNames(pr).includes('queue-hold') ? holdRemovedSince(gh, n, mine.at) : false;
    if (others.length || relabelled !== false) {
      // Only the caller's own hold is released (its Hold-By line goes, the new gated sha is
      // recorded); queue-hold stays, so REFUSED: nothing lands or queues.
      gh.prEdit(n, { body });
      const reason = others.length ? `queue-hold is still set by ${others.length} other holder(s)`
        : relabelled === null ? 'the queue-hold label history could not be read, so the label is left in place'
          : 'queue-hold was removed and set again after your hold, so it is not yours';
      return refuse(`${reason}; your hold line was removed and the gated sha recorded`);
    }
    gh.prEdit(n, { body, remove: labelNames(pr).includes('queue-hold') ? ['queue-hold'] : [] });
    released = true;
    pr = gh.prView(n);
    if (pr.state === 'MERGED') return mergedOut(pr);
    if (pr.headRefOid !== sha) throw new LandError(`PR #${n} head moved to ${pr.headRefOid} while releasing the hold; re-run the gate`);
  }

  const refused = refusal(gh, pr);
  if (refused) return refuse(refused);
  const labels = labelNames(pr);
  const blocked = labels.includes('queue-blocked');
  const base = pr.baseRefName || cfg.base;
  const headRef = pr.headRefName;
  fetchBranch(root, base);
  const current = isAncestor(`refs/remotes/origin/${base}`, sha, root);
  let line = othersInLine(gh, n);

  // Every fresh read of the PR gets every check, on that same object: open, the gated head,
  // the validated base and branch, and no refusal (hold, landing, unmerged Depends-on, pause).
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

  // Merge now: fair (nobody else in line), current, and not already in the queue system. The
  // base and the queue are checked again, then the last read before the merge, then fairness
  // once more and the lock itself.
  if (current && !['queued', 'queue-waiting', 'queue-blocked'].some((l) => labels.includes(l)) && line.count === 0) {
    fetchBranch(root, base);
    const stillCurrent = isAncestor(`refs/remotes/origin/${base}`, sha, root);
    line = othersInLine(gh, n);
    if (stillCurrent && line.count === 0) {
      pr = gh.prView(n);
      const lastRead = validate(pr);
      if (lastRead) return lastRead.done;
      line = othersInLine(gh, n);
      if (line.count === 0) {
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
    }
  }

  // Queue it, or refresh the gated sha of a PR already in line: written from a fresh read.
  pr = gh.prView(n);
  const again = validate(pr);
  if (again) return again.done;
  const now = labelNames(pr);
  line = othersInLine(gh, n);
  const full = queueFull(gh, cfg, n, now, line);
  const queued = now.includes('queued');
  const waitingNow = now.includes('queue-waiting');
  gh.ensureLabels();
  const prev = parseLanding(pr.body);
  const queuedAt = (queued || waitingNow) && prev.queuedAt ? prev.queuedAt : new Date().toISOString();
  const body = writeLanding(pr.body, { gateSha: sha, queuedAt });
  if (body !== pr.body) { gh.prEdit(n, { body }); pr.body = body; }
  const common = { pr: n, sha, refreshed: queued || waitingNow, requeue: blocked, released, current, lock: null };

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
