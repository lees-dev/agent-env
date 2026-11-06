// land-queue: the per-repo lander. Lands `queued` PRs one at a time, serially per repo.
//
// Usage:
//   node land-queue.mjs run    [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]
//   node land-queue.mjs status [--repo owner/name] [--root <checkout>] [--all] [--json]
//
// Repos: --root (default: the current checkout); --all reads ~/.agents/state/repos.json.
// For each PR, in order (landing, queue-next, Linear-Priority, time queued, number):
//   lock -> head == gated sha -> rebase in <main checkout>-lander -> range-diff unchanged ->
//   setup + affectedGate (one retry) -> push --force-with-lease -> merge pinned -> release.
// A PR that cannot land is bounced: queued/landing -> queue-blocked, one comment with the
// reason, and a `Bounced:` line in its `## Landing` section (the attempt count).
// A stale lock (older than lockTtlMin) is reported, and reclaimed only with --reclaim-stale.
// Output (--json): one report per repo
//   {repo, merged:[{pr,sha,mergeSha}], bounced:[{pr,reason,attempt}], queued, held:[n],
//    waiting:[{pr,dependsOn}], stale:[{host,pid,ageMin}], busy, alerts:[...], sweep}
// Exit: 0 when every repo was processed (bounces included), 1 on an error, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import {
  BOUNCE_MARKER, Gh, LandError, LandingLock,
  appendLanding, baseTreeOf, bumpMergeCount, classifyQueue, fetchBranch, firstLine, git, gitOk,
  isAncestor, isStale, labelNames, listQueue, loadRepoConfig, mainCheckout, markSwept, mergePinned, parseArgs,
  parseLanding, print, rangeDiffChanges, registeredRepos, repoTop, runAsync, scrub, setLabels, slugFromRemote, splitArgv, waitForPr,
} from './lib/land.mjs';

const USAGE = 'usage: node land-queue.mjs <run|status> [--repo owner/name] [--root <checkout>] [--all] [--json] [--dry-run] [--reclaim-stale]';
const MAX_PRS_PER_RUN = 50;
const MAX_BASE_RETRIES = 3;

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

async function runCommands(cmds, dir, lock, ttlMin) {
  const tickMs = Math.max(60000, Math.floor((ttlMin * 60000) / 3));
  for (const c of cmds) {
    const r = await runAsync(splitArgv(c), {
      cwd: dir, env: { ...process.env, AGENT_LANDER: '1' }, tickMs, onTick: () => lock.refresh(),
    });
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
  setLabels(gh, pr, { add: ['queue-blocked'], remove: ['queued', 'landing'] });
  const lines = [
    BOUNCE_MARKER,
    `**Land queue bounced this PR** (attempt ${attempt}): ${scrub(reason)}`,
    '',
    'Fix it on the branch, run the gate on the new head, then run `land-pr <n> --sha <new head>` again.',
  ];
  const t = tail.map(scrub).filter((l) => l.trim()).slice(-20);
  if (t.length) lines.push('', `Last ${t.length} lines of output:`, '', '```text', ...t.map((l) => l.replace(/```/g, "'''")), '```');
  gh.prComment(pr.number, `${lines.join('\n')}\n`);
  return { pr: pr.number, reason: scrub(reason), attempt };
}

// ---------------------------------------------------------------- one PR

async function landOne(ctx, pr) {
  const { gh, cfg, mainRoot, lock } = ctx;
  setLabels(gh, pr, { add: ['landing'], remove: ['queued'] });
  const gated = parseLanding(pr.body).gatedSha;
  if (!gated) return { bounced: bounce(gh, pr, 'no `Gate: pass @ <sha>` line in the ## Landing section') };
  if (!pr.headRefOid.startsWith(gated) && pr.headRefOid !== gated) {
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
    resetTo(dir, head);
    const rb = git(['-c', 'rebase.autoSquash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', baseRef], {
      cwd: dir, env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    if (rb.status !== 0) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split(/\r?\n/).filter(Boolean);
      git(['rebase', '--abort'], { cwd: dir });
      resetTo(dir, baseRef);
      const list = files.slice(0, 10).join(', ');
      return { bounced: bounce(gh, pr, `rebase onto ${base} conflicts in ${files.length} file(s)${list ? `: ${list}` : ''}`) };
    }
    const rd = git(['range-diff', '--no-color', `${forkPoint}..${head}`, `${baseRef}..HEAD`], { cwd: dir });
    if (rd.status !== 0) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `git range-diff failed: ${firstLine(rd.stderr)}`) };
    }
    const changes = rangeDiffChanges(rd.stdout);
    if (changes.changed.length) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `the rebase changed ${changes.changed.length} of ${changes.total} commit(s); it needs a review`, changes.changed) };
    }
    // Same patches on a newer base: rerun the affected gate only.
    let g = await runCommands([...cfg.setup, ...cfg.affectedGate], dir, lock, cfg.lockTtlMin);
    if (!g.ok) g = await runCommands(cfg.affectedGate, dir, lock, cfg.lockTtlMin);
    if (!g.ok) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `affected gate failed after the rebase (\`${g.cmd}\` exit ${g.status}, retried once)`, g.tail) };
    }
    landSha = gitOk(['rev-parse', 'HEAD'], { cwd: dir });
    const push = git(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, 'origin', `HEAD:refs/heads/${pr.headRefName}`], { cwd: dir });
    if (push.status !== 0) {
      resetTo(dir, baseRef);
      return { bounced: bounce(gh, pr, `push of the rebased head was rejected: ${firstLine(push.stderr || push.stdout)}`) };
    }
    const body = appendLanding(pr.body, `Gate: pass @ ${landSha} (lander rebase)`);
    gh.prEdit(pr.number, { body });
    pr.body = body;
    const seen = waitForPr(gh, pr.number, (p) => p.headRefOid === landSha);
    if (seen.headRefOid !== landSha) return { retry: true, note: 'GitHub has not seen the pushed head yet' };
  }

  // The base must still be an ancestor right before the merge.
  fetchBranch(dir, base);
  if (!isAncestor(baseRef, landSha, dir)) return { retry: true, note: `${base} moved during the landing` };
  const m = mergePinned(gh, cfg, { pr: pr.number, sha: landSha });
  resetTo(dir, baseRef);
  if (!m.ok) return { bounced: bounce(gh, pr, `merge failed: ${m.message}`) };
  return { merged: { pr: pr.number, sha: landSha, mergeSha: m.mergeSha, rebased } };
}

// ---------------------------------------------------------------- wide sweep

async function wideSweep(ctx, report, base) {
  const { gh, cfg, mainRoot, lock } = ctx;
  const count = bumpMergeCount(gh.repo);
  if (!cfg.wideSweep || count.sinceSweep < cfg.sweepEveryMerges) return;
  markSwept(gh.repo);
  const dir = landerCheckout(mainRoot, base);
  fetchBranch(dir, base);
  resetTo(dir, `refs/remotes/origin/${base}`);
  const cmds = Array.isArray(cfg.wideSweep) ? cfg.wideSweep : [cfg.wideSweep];
  const r = await runCommands([...cfg.setup, ...cmds], dir, lock, cfg.lockTtlMin);
  report.sweep = { ran: true, ok: r.ok, afterMerges: count.sinceSweep };
  if (r.ok) return;
  let held = 0;
  for (const pr of listQueue(gh)) { setLabels(gh, pr, { add: ['queue-hold'] }); held++; }
  report.alerts.push(`wide sweep on ${base} failed after ${count.sinceSweep} merges (\`${r.cmd}\` exit ${r.status}); queue-hold added to ${held} queued PR(s). File a ticket and fix ${base} first.`);
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

async function runRepo(t, opts) {
  const ctx = context(t);
  const { gh, cfg } = ctx;
  const report = { repo: t.repo, merged: [], bounced: [], queued: 0, held: [], waiting: [], stale: [], busy: false, alerts: [], sweep: null };
  const retries = new Map();
  if (!opts.dryRun) gh.ensureLabels();
  for (let i = 0; i < MAX_PRS_PER_RUN; i++) {
    const q = classifyQueue(gh, listQueue(gh));
    report.held = q.held;
    report.waiting = q.waiting;
    report.queued = q.eligible.length + q.waiting.length;
    if (!q.eligible.length) break;
    if (opts.dryRun) { report.plan = q.eligible.map((p) => p.number); break; }

    const pr = q.eligible[0];
    const base = pr.baseRefName || cfg.base;
    fetchBranch(ctx.root, base);
    const got = ctx.lock.acquire(baseTreeOf(ctx.root, `refs/remotes/origin/${base}`));
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
    try {
      res = await landOne(ctx, pr);
    } finally {
      ctx.lock.release();
    }
    if (res.merged) {
      report.merged.push(res.merged);
      await wideSweep(ctx, report, base);
    } else if (res.bounced) {
      report.bounced.push(res.bounced);
    } else if (res.retry) {
      const k = (retries.get(pr.number) || 0) + 1;
      retries.set(pr.number, k);
      if (k >= MAX_BASE_RETRIES) report.bounced.push(bounce(gh, pr, `could not land after ${k} tries: ${res.note}`));
    }
  }
  const after = classifyQueue(gh, listQueue(gh));
  report.queued = after.eligible.length + after.waiting.length;
  report.held = after.held;
  report.waiting = after.waiting;
  return report;
}

function statusRepo(t) {
  const ctx = context(t);
  const { gh } = ctx;
  const all = listQueue(gh);
  const q = classifyQueue(gh, all);
  const holder = ctx.lock.read();
  const lock = holder ? { host: holder.host, pid: holder.pid, ageMin: holder.ageMin, stale: isStale(holder, ctx.cfg.lockTtlMin) } : null;
  const row = (pr) => {
    const l = parseLanding(pr.body);
    return { pr: pr.number, title: pr.title, labels: labelNames(pr).filter((x) => x.startsWith('queue') || x === 'landing'), priority: l.priority, queuedAt: l.queuedAt, attempts: l.bounces.length };
  };
  return { repo: t.repo, lock, order: q.eligible.map(row), waiting: q.waiting, held: q.held };
}

function statusText(s) {
  const lines = [`${s.repo}: lock ${s.lock ? `held by ${s.lock.host} pid ${s.lock.pid}, ${s.lock.ageMin} min${s.lock.stale ? ' (STALE)' : ''}` : 'free'}`];
  s.order.forEach((r, i) => lines.push(`  ${i + 1}. #${r.pr} p${r.priority} ${r.labels.join(',')} ${r.title}`));
  for (const w of s.waiting) lines.push(`  waiting #${w.pr} on ${w.dependsOn.map((d) => `#${d}`).join(', ')}`);
  if (s.held.length) lines.push(`  held: ${s.held.map((n) => `#${n}`).join(', ')}`);
  if (!s.order.length && !s.waiting.length) lines.push('  queue empty');
  return lines.join('\n');
}

function runText(r) {
  const parts = [`${r.repo}: merged ${r.merged.length}, bounced ${r.bounced.length}, queued ${r.queued}, held ${r.held.length}`];
  for (const m of r.merged) parts.push(`  MERGED #${m.pr} ${m.mergeSha || m.sha}${m.rebased ? ' (lander rebase)' : ''}`);
  for (const b of r.bounced) parts.push(`  BOUNCED #${b.pr} attempt ${b.attempt}: ${b.reason}`);
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
  if (!['run', 'status'].includes(cmd)) throw new LandError(USAGE, 2);

  let targets;
  if (args.all) {
    targets = registeredRepos().map((r) => target(r));
    if (!targets.length) throw new LandError('no repos registered in ~/.agents/state/repos.json with an .agents/repo.json', 2);
  } else {
    targets = [target(args.root ? path.resolve(args.root) : repoTop(), args.repo)];
  }

  const reports = [];
  let failed = 0;
  for (const t of targets) {
    try {
      reports.push(cmd === 'run'
        ? await runRepo(t, { dryRun: Boolean(args['dry-run']), reclaimStale: Boolean(args['reclaim-stale']) })
        : statusRepo(t));
    } catch (e) {
      failed++;
      reports.push({ repo: t.repo, error: e instanceof LandError ? e.message : String(e?.message || e) });
    }
  }
  if (args.json) print(args.all ? reports : reports[0], true);
  else for (const r of reports) print(r.error ? `${r.repo}: ERROR ${r.error}` : cmd === 'run' ? runText(r) : statusText(r), false);
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`land-queue: ${e instanceof LandError ? e.message : e?.stack || e}\n`);
  process.exitCode = e instanceof LandError ? e.code : 1;
});
