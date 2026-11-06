// A fake `gh` for the land-queue tests, started by a gh.cmd / gh shim on PATH (land.test.mjs). Pull requests, labels and comments live in the JSON file $FAKE_GH_STATE. Git data
// (branches, the landing-lock ref, merges) lives in the bare repo $FAKE_GH_BARE, so the tools
// under test see a consistent remote through both gh and git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const STATE = process.env.FAKE_GH_STATE;
const BARE = process.env.FAKE_GH_BARE;
const argv = process.argv.slice(2);

function load() { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
function die(msg, http) { process.stderr.write(`${msg}${http ? ` (HTTP ${http})` : ''}\n`); process.exit(1); }
function git(...args) {
  const r = spawnSync('git', ['-C', BARE, ...args], { encoding: 'utf8', shell: false });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }

function opts(list) {
  const o = { _: [], f: {}, F: {} };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-f' || a === '-F') { const [k, ...v] = list[++i].split('='); o[a[1]][k] = v.join('='); continue; }
    if (a === '-X') { o.method = list[++i]; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) o[name] = true; else { o[name] = next; i++; }
      continue;
    }
    o._.push(a);
  }
  return o;
}

function headOid(pr) {
  const r = git('rev-parse', '--verify', `refs/heads/${pr.headRefName}`);
  return r.ok ? r.out : pr.headRefOid;
}

function view(pr) {
  return {
    number: pr.number, title: pr.title || `PR ${pr.number}`, state: pr.state || 'OPEN', isDraft: Boolean(pr.isDraft), isCrossRepository: Boolean(pr.isCrossRepository),
    headRefName: pr.headRefName, headRefOid: pr.state === 'MERGED' ? pr.headRefOid : headOid(pr), baseRefName: pr.baseRefName || 'main',
    labels: (pr.labels || []).map((name) => ({ name })), body: pr.body || '', createdAt: pr.createdAt || '2026-11-01T00:00:00Z',
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, url: `https://github.com/o/r/pull/${pr.number}`,
  };
}

function log(s, entry) { s.calls = s.calls || []; s.calls.push(entry); }

function pr(sub, rest) {
  const s = load();
  const o = opts(rest);
  const find = (n) => s.prs.find((p) => p.number === Number(n)) || die(`no pull requests found for ${n}`);
  if (sub === 'view') {
    const p = find(o._[0]);
    // Test hook: the first read of PR n after it merged fails (the merge itself went through).
    if (s.failViewAfterMerge === p.number && p.state === 'MERGED') { delete s.failViewAfterMerge; save(s); die('HTTP 502: Bad Gateway'); }
    // Test hook: GitHub lags behind a push. Once the PR body records a lander rebase, the next
    // staleHead.n reads of PR staleHead.pr still show staleHead.sha (the branch itself moved).
    const lag = s.staleHead;
    if (lag && lag.pr === p.number && lag.n > 0 && /\(lander rebase\)/.test(p.body || '')) {
      lag.n -= 1;
      save(s);
      process.stdout.write(JSON.stringify({ ...view(p), headRefOid: lag.sha }));
      return;
    }
    process.stdout.write(JSON.stringify(view(p)));
    // mutateAfter kind 'prView': counts the reads of that one PR.
    if (s.mutateAfter?.kind === 'prView' && s.mutateAfter.pr === p.number) { countAndMutate(s, 'prView'); save(s); }
    return;
  }
  if (sub === 'list') {
    // The staleHead lag shows in lists too (without using up its count).
    const lagged = (p) => (s.staleHead && s.staleHead.pr === p.number && s.staleHead.n > 0 && /\(lander rebase\)/.test(p.body || '')
      ? { ...view(p), headRefOid: s.staleHead.sha } : view(p));
    const out = s.prs.filter((p) => (p.state || 'OPEN') === 'OPEN' && (!o.label || (p.labels || []).includes(o.label))).map(lagged);
    process.stdout.write(JSON.stringify(out));
    // mutateAfter kind 'prList': counts the PR list reads.
    if (s.mutateAfter?.kind === 'prList') { countAndMutate(s, 'prList'); save(s); }
    return;
  }
  if (sub === 'edit') {
    const p = find(o._[0]);
    const add = o['add-label'] ? o['add-label'].split(',') : [];
    const remove = o['remove-label'] ? o['remove-label'].split(',') : [];
    for (const l of remove) if (!(p.labels || []).includes(l)) die(`label ${l} is not on the PR`);
    const newBody = o['body-file'] === '-' ? readStdin() : null;
    // Test hook: one body edit whose new text matches failBodyEditMatching fails (nothing is changed).
    if (newBody !== null && s.failBodyEditMatching && newBody.includes(s.failBodyEditMatching)) {
      delete s.failBodyEditMatching; save(s); die('HTTP 502: Bad Gateway');
    }
    const at = new Date().toISOString();
    s.events = s.events || [];
    for (const l of add) if (!(p.labels || []).includes(l)) s.events.push({ pr: p.number, event: 'labeled', label: { name: l }, created_at: at });
    for (const l of remove) s.events.push({ pr: p.number, event: 'unlabeled', label: { name: l }, created_at: at });
    p.labels = [...new Set([...(p.labels || []).filter((l) => !remove.includes(l)), ...add])];
    if (newBody !== null) p.body = newBody;
    // Test hook: queue-hold appears right after the lander records its rebase gate line.
    // Test hook: the base moves once, right after the lander records its rebase gate line.
    if (s.advanceBaseAfterLanderGate === p.number && /lander rebase/.test(p.body || '')) {
      delete s.advanceBaseAfterLanderGate;
      const base = p.baseRefName || 'main';
      const cur = git('rev-parse', `refs/heads/${base}`).out;
      const c = spawnSync('git', ['-C', BARE, 'commit-tree', `${cur}^{tree}`, '-p', cur, '-m', 'base moved'], { encoding: 'utf8', shell: false }).stdout.trim();
      git('update-ref', `refs/heads/${base}`, c, cur);
    }
    if (s.holdAfterLanderGate === p.number && /\(lander rebase\)/.test(p.body || '')) p.labels.push('queue-hold');
    log(s, { cmd: 'pr edit', pr: p.number, add, remove, body: o['body-file'] === '-' });
    save(s);
    return;
  }
  if (sub === 'comment') {
    const p = find(o._[0]);
    // Test hook: comments on PR n fail.
    if (s.failComment === p.number) die('HTTP 502: Bad Gateway');
    s.comments = s.comments || [];
    s.comments.push({ pr: p.number, body: readStdin() });
    save(s);
    return;
  }
  if (sub === 'merge') {
    const p = find(o._[0]);
    if (s.failMerge) die('GraphQL: Pull request is not mergeable');
    const head = headOid(p);
    if (o['match-head-commit'] && o['match-head-commit'] !== head) die('GraphQL: Head branch was modified. Review and try the merge again.');
    const base = p.baseRefName || 'main';
    const baseSha = git('rev-parse', `refs/heads/${base}`).out;
    if (!git('merge-base', '--is-ancestor', baseSha, head).ok) die('fake gh: head does not contain the base (strict fake)');
    const tree = git('rev-parse', `${head}^{tree}`).out;
    const c = spawnSync('git', ['-C', BARE, 'commit-tree', tree, '-p', baseSha, '-m', `${p.title || 'PR'} (#${p.number})`], { encoding: 'utf8', shell: false });
    const merged = c.stdout.trim();
    git('update-ref', `refs/heads/${base}`, merged, baseSha);
    if (o['delete-branch']) git('update-ref', '-d', `refs/heads/${p.headRefName}`);
    p.headRefOid = head;
    p.state = 'MERGED';
    p.mergeCommit = merged;
    log(s, { cmd: 'pr merge', pr: p.number, head, deleteBranch: Boolean(o['delete-branch']), method: ['squash', 'merge', 'rebase'].find((m) => o[m]) });
    save(s);
    return;
  }
  die(`fake gh: unsupported pr ${sub}`);
}

function label(sub, rest) {
  const s = load();
  const o = opts(rest);
  s.labels = s.labels || [];
  if (sub === 'list') { process.stdout.write(JSON.stringify(s.labels.map((name) => ({ name })))); return; }
  if (sub === 'create') {
    if (s.labels.includes(o._[0])) die('label already exists', 422);
    s.labels.push(o._[0]);
    save(s);
    return;
  }
  die(`fake gh: unsupported label ${sub}`);
}

// Test hook: right after the n-th call of one kind ('varGet': a repo variable read, 'lockGet':
// a landing-lock ref read), change one PR once, so only the reads after it see the change:
// s.mutateAfter = { kind, n, pr, base?, appendBody?, addLabel?, steal? }; kind 'prView' counts reads of PR `pr`.
// steal: another lander replaces the landing lock (its sha goes to mutateAfter.stolen).
function countAndMutate(s, kind) {
  const m = s.mutateAfter;
  if (!m || m.kind !== kind) return;
  m.seen = (m.seen || 0) + 1;
  if (m.seen !== m.n) return;
  const p = s.prs.find((x) => x.number === m.pr);
  if (m.base) p.baseRefName = m.base;
  if (m.appendBody) p.body = `${p.body || ''}${m.appendBody}`;
  if (m.addLabel) p.labels = [...new Set([...(p.labels || []), m.addLabel])];
  if (m.steal) {
    const lock = 'refs/heads/agent-landing-lock';
    const g = (...a) => spawnSync('git', ['-C', BARE, ...a], { encoding: 'utf8', shell: false }).stdout.trim();
    m.stolen = g('commit-tree', g('rev-parse', `${lock}^{tree}`), '-m', `agent-landing-lock host=other pid=1 at=${new Date().toISOString()} ttl=45`);
    g('update-ref', lock, m.stolen);
  }
}

function api(rest) {
  const o = opts(rest);
  const method = o.method || 'GET';
  const route = o._[0];
  const v = route.match(/^repos\/[^/]+\/[^/]+\/actions\/variables(?:\/([A-Z0-9_]+))?$/);
  if (v) {
    const s = load();
    s.variables = s.variables || {};
    log(s, { cmd: 'api', method, route: `variables/${v[1] || ''}` });
    if (method === 'GET') {
      countAndMutate(s, 'varGet');
      save(s);
      if (!(v[1] in s.variables)) die('Not Found', 404);
      process.stdout.write(JSON.stringify({ name: v[1], value: s.variables[v[1]] }));
      return;
    }
    // Test hook: writing repo variables fails (setting the pause cannot be recorded).
    if (s.variablesWriteFail && method !== 'GET') { save(s); die('Server Error', 500); }
    if (method === 'POST') {
      if (o.f.name in s.variables) { save(s); die('Already exists', 409); }
      s.variables[o.f.name] = o.f.value;
    } else if (method === 'PATCH') {
      if (!(v[1] in s.variables)) { save(s); die('Not Found', 404); }
      s.variables[v[1]] = o.f.value;
    } else if (method === 'DELETE') {
      if (!(v[1] in s.variables)) { save(s); die('Not Found', 404); }
      delete s.variables[v[1]];
    }
    save(s);
    return;
  }
  const ev = route.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events(?:\?(.*))?$/);
  if (ev && method === 'GET') {
    const s = load();
    if (s.eventsFail) die('Server Error', 500);
    const page = Number(new URLSearchParams(ev[2] || '').get('page') || 1);
    const list = (s.events || []).filter((e) => e.pr === Number(ev[1]));
    process.stdout.write(JSON.stringify(page === 1 ? list : []));
    return;
  }
  const m = route.match(/^repos\/[^/]+\/[^/]+\/git\/(.*)$/) || die(`fake gh: unsupported api ${route}`);
  const p = m[1];
  const s = load();
  log(s, { cmd: 'api', method, route: p });
  save(s);
  if (p === 'commits' && method === 'POST') {
    const c = spawnSync('git', ['-C', BARE, 'commit-tree', o.f.tree, '-p', o.f['parents[]'], '-m', o.f.message], { encoding: 'utf8', shell: false });
    if (c.status !== 0) die('Validation Failed', 422);
    process.stdout.write(JSON.stringify({ sha: c.stdout.trim() }));
    return;
  }
  let mm;
  if ((mm = p.match(/^commits\/([0-9a-f]+)$/)) && method === 'GET') {
    const msg = git('log', '-1', '--format=%B', mm[1]);
    if (!msg.ok) die('Not Found', 404);
    process.stdout.write(JSON.stringify({ sha: mm[1], message: msg.out, tree: { sha: git('rev-parse', `${mm[1]}^{tree}`).out } }));
    return;
  }
  if (p === 'refs' && method === 'POST') {
    if (s.lockApiDown) die('Server Error', 500);
    // Test hook: the next refFail422 creates fail with 422 and create nothing (not contention).
    if (s.refFail422 > 0) { s.refFail422 -= 1; save(s); die('Validation Failed', 422); }
    const r = git('update-ref', o.f.ref, o.f.sha, '');
    if (!r.ok) die('Reference already exists', 422);
    process.stdout.write(JSON.stringify({ ref: o.f.ref, object: { sha: o.f.sha } }));
    return;
  }
  if ((mm = p.match(/^ref\/(heads\/.+)$/)) && method === 'GET') {
    if (mm[1] === 'heads/agent-landing-lock') { countAndMutate(s, 'lockGet'); save(s); }
    const r = git('rev-parse', '--verify', `refs/${mm[1]}`);
    if (!r.ok) die('Not Found', 404);
    process.stdout.write(JSON.stringify({ ref: `refs/${mm[1]}`, object: { sha: r.out } }));
    return;
  }
  if ((mm = p.match(/^refs\/(heads\/.+)$/)) && method === 'PATCH') {
    const cur = git('rev-parse', '--verify', `refs/${mm[1]}`);
    if (!cur.ok) die('Reference does not exist', 422);
    if (o.F.force !== 'true' && !git('merge-base', '--is-ancestor', cur.out, o.f.sha).ok) die('Update is not a fast forward', 422);
    git('update-ref', `refs/${mm[1]}`, o.f.sha, cur.out);
    process.stdout.write(JSON.stringify({ object: { sha: o.f.sha } }));
    return;
  }
  if ((mm = p.match(/^refs\/(heads\/.+)$/)) && method === 'DELETE') {
    if (!git('update-ref', '-d', `refs/${mm[1]}`).ok) die('Reference does not exist', 422);
    return;
  }
  die(`fake gh: unsupported api ${method} ${route}`);
}

const [group, sub, ...rest] = argv;
if (group === 'pr') pr(sub, rest);
else if (group === 'label') label(sub, rest);
else if (group === 'api') api([sub, ...rest]);
else die(`fake gh: unsupported ${argv.join(' ')}`);
