#!/usr/bin/env node
// agent-secret: store credentials in 1Password for agent work (docs/lifecycle.md).
//
//   node agent-secret.mjs put <item> <FIELD> [--vault V] [--repo NAME] [--env dev|test] [--notes TEXT] [--replace]
//   node agent-secret.mjs import --env <file> --map <map.json> [--dry-run] [--retire-source] [--vault V] [--replace]
//   node agent-secret.mjs ref <item> <FIELD> [--vault V]
//   node agent-secret.mjs check [--vault V]
//
// Values travel only on stdin, inside a JSON template piped to op, and through op read for
// verification (compared by SHA-256 in memory). Output is references and counts only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureToken, opStatus, runOp } from './lib/op.mjs';
import { git, gitOut } from './lib/proc.mjs';
import { canonKey, isUnder, loadConfig, repoName, samePath } from './lib/repo.mjs';

const SELF = fileURLToPath(import.meta.url);
const NAME = 'agent-secret';
const SECTION = 'agent-secret';
const ITEM_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const VAULT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const ENVS = ['dev', 'test', 'prod'];
const LEADING_BOM = new RegExp('^' + String.fromCharCode(0xfeff));
const PROD_REFUSED = 'production values never go into agent-repos; they stay in the deploy platform';

const USAGE = `usage:
  agent-secret put <item> <FIELD> [--vault agent-repos] [--repo NAME] [--env dev|test] [--notes TEXT] [--replace]   (value on stdin)
  agent-secret import --env <file> --map <map.json> [--dry-run] [--retire-source] [--vault V] [--repo NAME] [--replace]
  agent-secret ref <item> <FIELD> [--vault V]
  agent-secret check [--vault V]
items are named <repo>-<service>-<env> (env dev or test; prod is refused); the field label is the env var name.`;

class UsageError extends Error {}

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`${NAME}: ${msg}\n`); }
function sha(v) { return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex'); }
function firstLine(s) { return String(s || '').trim().split(/\r?\n/)[0].slice(0, 200); }

export function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(['--vault', '--repo', '--env', '--notes', '--map']);
  const flags = new Set(['--replace', '--dry-run', '--retire-source']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (flags.has(a)) opts[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

/** Repo of the cwd: {top, cfg, name} or null. */
function cwdRepo() {
  const top = gitOut(['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
  if (!top) return null;
  const cfg = loadConfig(top);
  return { top: path.resolve(top), cfg, name: repoName(cfg, top) };
}

function vaultOf(opts, repo) {
  // repo.json's "vault" belongs to the landing tools; secrets default to agent-repos.
  const v = opts.vault || 'agent-repos';
  if (!VAULT_RE.test(v)) throw new UsageError('invalid vault name');
  return v;
}

export function reference(vault, item, field) { return `op://${vault}/${item}/${field}`; }

function envOfItem(item) {
  const m = item.match(/-(dev|test|prod)$/);
  return m ? m[1] : null;
}

/**
 * Parse a dotenv file as data: KEY=VALUE, optional `export`, '...' literal, "..." with
 * escapes (may span lines), unquoted values lose a trailing ` # comment`. Returns a Map.
 */
export function parseEnvFile(text) {
  const out = new Map();
  const lines = String(text).replace(LEADING_BOM, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/);
    if (!m) continue;
    const key = m[1];
    // `KEY= # note` is an empty value with a comment; `KEY=#x` keeps its literal value.
    if (/^\s+#/.test(m[2])) { out.set(key, ''); continue; }
    let rest = m[2].trimStart();
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = rest.slice(1);
      let end = findClose(body, q);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = findClose(body, q);
      }
      if (end < 0) throw new Error(`unterminated quote for ${key}`);
      let v = body.slice(0, end);
      if (q === '"') v = v.replace(/\\(n|r|t|"|\\)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[c]));
      out.set(key, v);
    } else {
      rest = rest.replace(/\s+#.*$/, '').trim();
      out.set(key, rest);
    }
  }
  return out;
}

function findClose(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) return i;
  }
  return -1;
}

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('pipe the value on stdin (it is never read from arguments)');
  const v = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!v) throw new UsageError('empty value on stdin');
  return v;
}

function requireOp() {
  const st = opStatus();
  if (!st.op) throw new Error('op (1Password CLI) not found');
  if (!st.hasToken) throw new Error('no OP_SERVICE_ACCOUNT_TOKEN in the environment, the user environment or the token file');
}

/** op item get: {item} | {missing:true}. Throws on other failures. */
function getItem(vault, item) {
  const r = runOp(['item', 'get', item, '--vault', vault, '--format', 'json']);
  if (r.status === 0) {
    try { return { item: JSON.parse(r.stdout) }; } catch { throw new Error('op item get: output is not JSON'); }
  }
  if (/isn't an item|not found|no item/i.test(r.stderr)) return { missing: true };
  throw new Error(`op item get failed (exit ${r.status}): ${firstLine(r.stderr)}`);
}

/** Passkey metadata on an item (a passkeys list, or a field or section typed as one). */
function hasPasskey(item) {
  if (!item) return false;
  if (Array.isArray(item.passkeys) ? item.passkeys.length : item.passkey) return true;
  const typed = (x) => x && /passkey/i.test(String(x.type || x.purpose || ''));
  return (item.fields || []).some(typed) || (item.sections || []).some(typed);
}

function isOurs(field) {
  return Boolean(field && field.section && (field.section.id === SECTION || field.section.label === SECTION));
}

/**
 * Merge fields into an existing item JSON. A field with the same label (or id) that this tool
 * did not create is refused unless replace. Returns {item, refused, changed}.
 */
export function mergeFields(item, fields, { replace = false, repo = null, notes = null } = {}) {
  const next = JSON.parse(JSON.stringify(item));
  next.fields = Array.isArray(next.fields) ? next.fields : [];
  next.sections = Array.isArray(next.sections) ? next.sections : [];
  const refused = [];
  let changed = 0;
  for (const { name, value } of fields) {
    const hit = next.fields.find((f) => f.label === name || f.id === name);
    if (hit) {
      if (!isOurs(hit) && !replace) { refused.push(name); continue; }
      hit.value = value;
      if (!hit.type || hit.type === 'STRING') hit.type = 'CONCEALED';
    } else {
      next.fields.push({ id: name, label: name, type: 'CONCEALED', value, section: { id: SECTION } });
    }
    changed++;
  }
  if (changed && next.fields.some((f) => isOurs(f)) && !next.sections.some((s) => s.id === SECTION)) {
    next.sections.push({ id: SECTION, label: SECTION });
  }
  if (repo) {
    next.tags = Array.isArray(next.tags) ? next.tags : [];
    if (!next.tags.includes(`repo:${repo}`)) next.tags.push(`repo:${repo}`);
  }
  if (notes) {
    const n = next.fields.find((f) => f.purpose === 'NOTES' || f.id === 'notesPlain');
    if (n) n.value = notes;
    else next.fields.push({ id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: notes });
  }
  return { item: next, refused, changed };
}

/** JSON template for a new item. */
export function newItem(title, fields, { repo = null, notes = null } = {}) {
  const tags = ['agent-created'];
  if (repo) tags.unshift(`repo:${repo}`);
  const item = {
    title,
    category: 'API_CREDENTIAL',
    tags,
    sections: [{ id: SECTION, label: SECTION }],
    fields: fields.map(({ name, value }) => ({ id: name, label: name, type: 'CONCEALED', value, section: { id: SECTION } })),
  };
  if (notes) item.fields.push({ id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: notes });
  return item;
}

/** Create or edit one item with the given fields. Returns {refused, written}. */
function storeItem(vault, title, fields, o) {
  const got = getItem(vault, title);
  if (got.missing) {
    const r = runOp(['item', 'create', '--vault', vault, '--format', 'json', '-'], { input: JSON.stringify(newItem(title, fields, o)) });
    if (r.status !== 0) throw new Error(`op item create failed (exit ${r.status}): ${firstLine(r.stderr)}`);
    return { refused: [], written: fields.map((f) => f.name), created: true };
  }
  // A JSON-template edit overwrites passkeys (1Password docs): never edit such an item.
  if (hasPasskey(got.item)) throw new Error(`${title} holds a passkey; edit it in the 1Password app instead`);
  const merged = mergeFields(got.item, fields, o);
  if (!merged.changed) return { refused: merged.refused, written: [] };
  const id = got.item.id || title;
  const r = runOp(['item', 'edit', id, '--vault', vault, '--format', 'json'], { input: JSON.stringify(merged.item) });
  if (r.status !== 0) throw new Error(`op item edit failed (exit ${r.status}): ${firstLine(r.stderr)}`);
  const written = fields.map((f) => f.name).filter((n) => !merged.refused.includes(n));
  return { refused: merged.refused, written };
}

/** Read the reference back and compare hashes; true when they match. */
function verify(ref, value) {
  const r = runOp(['read', '--no-newline', ref]);
  if (r.status !== 0) return false;
  return sha(r.stdout) === sha(value);
}

/** Add NAME=ref to a template file unless NAME is already defined there. */
export function appendRef(file, name, ref) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const key = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (m) return m[1].trim() === ref ? 'present' : 'conflict';
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${name}=${ref}\n`);
  return 'added';
}

/**
 * Move <src> to <src>.pre-op: never over an existing file, only when git ignores the
 * destination, and with mode 0600. Returns the refusal reason or null.
 */
function retireSource(src) {
  const dest = `${src}.pre-op`;
  if (fs.existsSync(dest) || isLink(dest)) return `${path.basename(dest)} already exists`;
  const dir = path.dirname(src);
  if (!gitOut(['rev-parse', '--show-toplevel'], { cwd: dir })) return 'the source is not inside a git checkout';
  if (git(['check-ignore', '-q', '--', dest], { cwd: dir }).status !== 0) return `${path.basename(dest)} would not be git-ignored`;
  // Create the copy private from the start (exclusive, mode 0600), then fill it.
  try {
    const fd = fs.openSync(dest, 'wx', 0o600);
    try { fs.writeFileSync(fd, fs.readFileSync(src)); } finally { fs.closeSync(fd); }
  } catch (e) { return `could not create ${path.basename(dest)} (${e.code || e.message})`; }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dest, 0o600); } catch (e) {
      return `${path.basename(dest)} could not be made private (${e.code || e.message}); the source was kept`;
    }
  }
  try { fs.unlinkSync(src); } catch (e) {
    return `copied to ${path.basename(dest)} but could not delete the source (${e.code || e.message}); delete one copy before retrying`;
  }
  return null;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Item-name prefix for a repo: the cwd repo's itemPrefix when it is that repo, else the name. */
function prefixFor(name, repo) {
  const n = String(name).toLowerCase();
  if (repo && repo.name === n && repo.cfg.itemPrefix) return String(repo.cfg.itemPrefix).toLowerCase();
  return n;
}

/** The repo's env template: a file inside the checkout, not a link and not under one. */
function templateFile(repo) {
  const top = path.resolve(repo.top);
  const file = path.resolve(top, repo.cfg.env.template || '.env.op');
  if (!isUnder(file, top) || samePath(file, top)) throw new UsageError('env.template must be a file inside the checkout');
  for (let cur = file; !samePath(cur, top); cur = path.dirname(cur)) {
    if (isLink(cur)) throw new UsageError('env.template must not be a link or sit under one');
  }
  return file;
}

const NEEDS_ENV = 'item names end in -dev or -test (<repo>-<service>-<env>)';

// ---------------------------------------------------------------- commands

function cmdPut(opts) {
  const [item, field] = opts._.slice(1);
  if (!item || !field) throw new UsageError('put needs <item> <FIELD>');
  if (!ITEM_RE.test(item)) throw new UsageError('item names are lowercase <repo>-<service>-<env>');
  if (!FIELD_RE.test(field)) throw new UsageError('FIELD must be an env var name');
  if (opts.env && !ENVS.includes(opts.env)) throw new UsageError('--env is dev or test');
  if (opts.env === 'prod' || envOfItem(item) === 'prod') throw new UsageError(PROD_REFUSED);
  if (!envOfItem(item)) throw new UsageError(NEEDS_ENV);
  const repo = cwdRepo();
  const prefix = opts.repo ? prefixFor(opts.repo, repo) : null;
  if (prefix && !item.startsWith(`${prefix}-`)) throw new UsageError(`item names for --repo ${opts.repo} start with ${prefix}-`);
  const vault = vaultOf(opts, repo);
  const addsRef = Boolean(opts.repo && repo && repo.name === opts.repo.toLowerCase() && vault === 'agent-repos');
  const tplFile = addsRef ? templateFile(repo) : null;
  const value = readStdin();
  requireOp();
  const res = storeItem(vault, item, [{ name: field, value }], { replace: opts.replace, repo: opts.repo ? opts.repo.toLowerCase() : null, notes: opts.notes || null });
  if (res.refused.length) {
    warn(`refused: field ${field} exists in ${item} and was not created by ${NAME}; pass --replace to overwrite`);
    return 1;
  }
  const ref = reference(vault, item, field);
  if (!verify(ref, value)) { warn(`verification failed for ${ref} (read-back hash differs or read failed)`); return 1; }
  log(`stored ${ref}`);
  if (tplFile) {
    const file = tplFile;
    const st = appendRef(file, field, ref);
    if (st === 'added') log(`added ${field} to ${path.basename(file)}`);
    else if (st === 'conflict') warn(`${path.basename(file)} already defines ${field} with another value; left unchanged`);
  }
  return 0;
}

function cmdImport(opts) {
  if (!opts.env || !opts.map) throw new UsageError('import needs --env <file> --map <map.json>');
  const src = path.resolve(opts.env);
  if (!fs.existsSync(src)) throw new UsageError(`env file not found: ${path.basename(src)}`);
  let map;
  try { map = JSON.parse(fs.readFileSync(path.resolve(opts.map), 'utf8')); } catch (e) { throw new UsageError(`map is not valid JSON: ${e.message}`); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new UsageError('map must be an object');
  const values = parseEnvFile(fs.readFileSync(src, 'utf8'));
  const repo = cwdRepo();
  const vault = vaultOf(opts, repo);
  const importPrefix = opts.repo ? prefixFor(opts.repo, repo) : null;
  const tplFile = repo ? templateFile(repo) : null;

  const groups = new Map();
  let skipped = 0;
  for (const [key, value] of values) {
    const m = map[key];
    if (m === undefined || m === 'skip' || m === null) { skipped++; continue; }
    const item = typeof m === 'string' ? m : m.item;
    if (!item || !ITEM_RE.test(item)) throw new UsageError(`map entry for ${key}: invalid item name`);
    const field = (typeof m === 'object' && m.field) || key;
    if (!FIELD_RE.test(field)) throw new UsageError(`map entry for ${key}: invalid field name`);
    const env = (typeof m === 'object' && m.env) || envOfItem(item);
    if (env && !ENVS.includes(env)) throw new UsageError(`map entry for ${key}: env is dev or test`);
    if (env === 'prod' || envOfItem(item) === 'prod') throw new UsageError(`map entry for ${key}: ${PROD_REFUSED}`);
    if (!envOfItem(item)) throw new UsageError(`map entry for ${key}: ${NEEDS_ENV}`);
    if (importPrefix && !item.startsWith(`${importPrefix}-`)) throw new UsageError(`map entry for ${key}: item names for --repo ${opts.repo} start with ${importPrefix}-`);
    if (!groups.has(item)) groups.set(item, []);
    const previous = groups.get(item).find((e) => e.name === field);
    if (previous && previous.value !== value) {
      throw new UsageError(`map entries ${previous.key} and ${key} both target ${item}/${field} with different values`);
    }
    groups.get(item).push({ key, name: field, value, env });
  }
  const missing = Object.keys(map).filter((k) => map[k] !== 'skip' && !values.has(k)).length;
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  if (opts.dryRun) {
    log(`dry run: would migrate ${total} into ${groups.size} items in ${vault}, skip ${skipped}${missing ? `, ${missing} mapped keys not in the file` : ''}`);
    return 0;
  }
  requireOp();
  let migrated = 0;
  let mismatches = 0;
  let refused = 0;
  const lines = [];
  for (const [item, entries] of groups) {
    const tagRepo = opts.repo ? opts.repo.toLowerCase() : repo ? repo.name : null;
    const res = storeItem(vault, item, entries, { replace: opts.replace, repo: tagRepo });
    refused += res.refused.length;
    const inTemplate = vault === 'agent-repos' && repo && item.startsWith(`${prefixFor(repo.name, repo)}-`);
    for (const e of entries) {
      if (!res.written.includes(e.name)) continue;
      const ref = reference(vault, item, e.name);
      if (!verify(ref, e.value)) { mismatches++; continue; }
      migrated++;
      if (inTemplate) lines.push([e.key, ref]);
    }
  }
  skipped += refused;
  if (refused) warn(`${refused} fields refused: they exist and were not created by ${NAME} (use --replace)`);
  if (tplFile && lines.length) {
    const file = tplFile;
    let added = 0;
    let conflicts = 0;
    for (const [k, ref] of lines) {
      const st = appendRef(file, k, ref);
      if (st === 'added') added++;
      if (st === 'conflict') conflicts++;
    }
    log(`${path.basename(file)}: ${added} lines added${conflicts ? `, ${conflicts} existing lines left unchanged` : ''}`);
  }
  log(`migrated ${migrated}, skipped ${skipped}, mismatches ${mismatches}`);
  if (missing) warn(`${missing} mapped keys were not in the env file`);
  let retired = true;
  if (opts.retireSource) {
    if (mismatches || refused) { warn('source not retired: fix the mismatches or refusals first'); retired = false; }
    else {
      const why = retireSource(src);
      if (why) { warn(`source not retired: ${why}`); retired = false; }
      else log(`source renamed to ${path.basename(src)}.pre-op`);
    }
  }
  return mismatches || refused || !retired ? 1 : 0;
}

function cmdRef(opts) {
  const [item, field] = opts._.slice(1);
  if (!item || !field) throw new UsageError('ref needs <item> <FIELD>');
  if (!ITEM_RE.test(item) || !FIELD_RE.test(field)) throw new UsageError('invalid item or field name');
  log(reference(vaultOf(opts), item, field));
  return 0;
}

function cmdCheck(opts) {
  const vault = vaultOf(opts);
  const st = opStatus();
  log(`op: ${st.op ? 'found' : 'not found'}; token: ${st.hasToken ? 'present' : 'missing'}`);
  if (!st.op || !st.hasToken) return 1;
  const who = runOp(['whoami', '--format', 'json']);
  let type = 'unknown';
  try { type = JSON.parse(who.stdout).user_type || 'unknown'; } catch { /* not JSON */ }
  if (who.status !== 0) { log(`whoami failed (exit ${who.status})`); return 1; }
  log(`account type: ${type}`);
  const vl = runOp(['vault', 'list', '--format', 'json']);
  if (vl.status !== 0) { log(`vault list failed (exit ${vl.status})`); return 1; }
  let vaults = [];
  try { vaults = JSON.parse(vl.stdout) || []; } catch { /* not JSON */ }
  const visible = vaults.some((v) => v.name === vault || v.id === vault);
  log(`vaults visible: ${vaults.length}; ${vault}: ${visible ? 'visible' : 'NOT visible'}`);
  return visible ? 0 : 1;
}

export async function main(argv) {
  captureToken();
  let opts;
  try {
    opts = parseArgs(argv);
    const cmd = opts._[0];
    if (opts.help || !cmd) { log(USAGE); return opts.help ? 0 : 2; }
    switch (cmd) {
      case 'put': return cmdPut(opts);
      case 'import': return cmdImport(opts);
      case 'ref': return cmdRef(opts);
      case 'check': return cmdCheck(opts);
      default: throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    warn(e.message);
    if (e instanceof UsageError) { process.stderr.write(`${USAGE}\n`); return 2; }
    return 1;
  }
}

// Compare canonical paths: Node resolves links in import.meta.url but not in argv[1].
if (process.argv[1] && canonKey(process.argv[1]) === canonKey(SELF)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
