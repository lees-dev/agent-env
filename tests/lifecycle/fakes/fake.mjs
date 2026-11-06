// One fake for gh, docker and op, selected by argv[2]. State lives in the JSON file named by
// FAKE_STATE; every call is appended to FAKE_LOG as {tool, args, hasToken}. Test data only.
import fs from 'node:fs';

const [tool, ...args] = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args, hasToken: Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN) }) + '\n');

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (s) => process.stdout.write(s);
const fail = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const stdin = () => fs.readFileSync(0, 'utf8');

function gh() {
  const g = state.gh || {};
  if (g.fail) fail('gh: authentication required', 4);
  if (args[0] === 'pr' && args[1] === 'list') {
    let prs = g.prs || [];
    const head = flag('--head');
    const base = flag('--base');
    const st = flag('--state') || 'open';
    if (head) prs = prs.filter((p) => p.headRefName === head);
    if (base) prs = prs.filter((p) => p.baseRefName === base);
    if (st === 'open') prs = prs.filter((p) => p.state === 'OPEN');
    const fields = (flag('--json') || '').split(',').filter(Boolean);
    out(JSON.stringify(prs.map((p) => Object.fromEntries(fields.map((f) => [f, p[f]])))));
    return;
  }
  if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
    g.deleted = [...(g.deleted || []), args[3]];
    save();
    if (g.deleteStatus === 422) fail('gh: Reference does not exist (HTTP 422)');
    out('');
    return;
  }
  fail(`fake gh: unsupported ${args.join(' ')}`, 99);
}

function docker() {
  const d = state.docker || { containers: [], volumes: [], networks: [] };
  const filter = (list) => {
    const f = flag('--filter');
    if (!f) return list;
    const [, kv] = f.split('label=');
    const [k, v] = kv.split('=');
    return list.filter((x) => (v === undefined ? k in (x.labels || {}) : (x.labels || {})[k] === v));
  };
  const remove = (key, id) => {
    const before = d[key].length;
    d[key] = d[key].filter((x) => x.id !== id);
    save();
    if (d[key].length === before) fail(`Error: No such object: ${id}`);
  };
  if (args[0] === 'ps') { out(filter(d.containers).map((c) => c.id).join('\n') + '\n'); return; }
  if (args[0] === 'rm') { remove('containers', args[args.length - 1]); return; }
  if (args[0] === 'volume' && args[1] === 'ls') { out(filter(d.volumes).map((c) => c.id).join('\n') + '\n'); return; }
  if (args[0] === 'volume' && args[1] === 'rm') { remove('volumes', args[args.length - 1]); return; }
  if (args[0] === 'network' && args[1] === 'ls') { out(filter(d.networks).map((c) => c.id).join('\n') + '\n'); return; }
  if (args[0] === 'network' && args[1] === 'rm') { remove('networks', args[args.length - 1]); return; }
  fail(`fake docker: unsupported ${args.join(' ')}`, 99);
}

function op() {
  const o = state.op || { items: [], vaults: [] };
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) fail('[ERROR] no service account token', 1);
  const findItem = (vault, key) => o.items.find((i) => i.vault === vault && (i.title === key || i.id === key));
  const resolve = (ref) => {
    const parts = ref.replace(/^op:\/\//, '').split('/');
    const [vault, item] = parts;
    const field = parts[parts.length - 1];
    const it = findItem(vault, item);
    const f = it && it.fields.find((x) => x.label === field || x.id === field);
    return f ? f.value : null;
  };
  if (args[0] === 'inject') {
    const text = fs.readFileSync(flag('-i'), 'utf8');
    let missing = 0;
    const res = text.replace(/op:\/\/[^\s"']+/g, (ref) => {
      const v = resolve(ref);
      if (v === null) missing++;
      return v ?? '';
    });
    if (missing) fail('[ERROR] could not resolve a reference');
    fs.writeFileSync(flag('-o'), res, { mode: 0o600 });
    return;
  }
  if (args[0] === 'item' && args[1] === 'get') {
    const it = findItem(flag('--vault'), args[2]);
    if (!it) fail(`[ERROR] "${args[2]}" isn't an item in the "${flag('--vault')}" vault.`);
    out(JSON.stringify(it));
    return;
  }
  if (args[0] === 'item' && args[1] === 'create') {
    const tpl = JSON.parse(stdin());
    const it = { ...tpl, id: `id${o.items.length + 1}`, vault: flag('--vault') };
    o.items.push(it);
    save();
    out(JSON.stringify(it));
    return;
  }
  if (args[0] === 'item' && args[1] === 'edit') {
    const tpl = JSON.parse(stdin());
    const i = o.items.findIndex((x) => x.vault === flag('--vault') && (x.id === args[2] || x.title === args[2]));
    if (i < 0) fail('[ERROR] item not found');
    o.items[i] = { ...tpl, id: o.items[i].id, vault: o.items[i].vault };
    save();
    out(JSON.stringify(o.items[i]));
    return;
  }
  if (args[0] === 'read') {
    const v = resolve(args[args.length - 1]);
    if (v === null) fail('[ERROR] could not read secret');
    out(o.corruptRead ? `${v}x` : v);
    return;
  }
  if (args[0] === 'whoami') { out(JSON.stringify({ user_type: 'SERVICE_ACCOUNT', url: 'team.example.com' })); return; }
  if (args[0] === 'vault' && args[1] === 'list') { out(JSON.stringify(o.vaults || [])); return; }
  fail(`fake op: unsupported ${args.join(' ')}`, 99);
}

({ gh, docker, op })[tool]();
