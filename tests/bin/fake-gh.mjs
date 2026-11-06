// A fake `gh` for the land-queue tests. Installed on PATH as gh.mjs; land.mjs runs .mjs shims
// with node. Pull requests, labels and comments live in the JSON file $FAKE_GH_STATE. Git data
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
    number: pr.number, title: pr.title || `PR ${pr.number}`, state: pr.state || 'OPEN', isDraft: Boolean(pr.isDraft),
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
  if (sub === 'view') { process.stdout.write(JSON.stringify(view(find(o._[0])))); return; }
  if (sub === 'list') {
    const out = s.prs.filter((p) => (p.state || 'OPEN') === 'OPEN' && (!o.label || (p.labels || []).includes(o.label))).map(view);
    process.stdout.write(JSON.stringify(out));
    return;
  }
  if (sub === 'edit') {
    const p = find(o._[0]);
    const add = o['add-label'] ? o['add-label'].split(',') : [];
    const remove = o['remove-label'] ? o['remove-label'].split(',') : [];
    for (const l of remove) if (!(p.labels || []).includes(l)) die(`label ${l} is not on the PR`);
    p.labels = [...new Set([...(p.labels || []).filter((l) => !remove.includes(l)), ...add])];
    if (o['body-file'] === '-') p.body = readStdin();
    // Test hook: queue-hold appears right after the lander records its rebase gate line.
    if (s.holdAfterLanderGate === p.number && /\(lander rebase\)/.test(p.body || '')) p.labels.push('queue-hold');
    log(s, { cmd: 'pr edit', pr: p.number, add, remove, body: o['body-file'] === '-' });
    save(s);
    return;
  }
  if (sub === 'comment') {
    const p = find(o._[0]);
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
      save(s);
      if (!(v[1] in s.variables)) die('Not Found', 404);
      process.stdout.write(JSON.stringify({ name: v[1], value: s.variables[v[1]] }));
      return;
    }
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
    const r = git('update-ref', o.f.ref, o.f.sha, '');
    if (!r.ok) die('Reference already exists', 422);
    process.stdout.write(JSON.stringify({ ref: o.f.ref, object: { sha: o.f.sha } }));
    return;
  }
  if ((mm = p.match(/^ref\/(heads\/.+)$/)) && method === 'GET') {
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
