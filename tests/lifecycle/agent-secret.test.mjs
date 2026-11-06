// node --test tests/lifecycle/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DUMMY_TOKEN, SECRET, isWin, makeRepo, scratch, secret, write } from './helpers.mjs';

const { parseEnvFile, mergeFields, appendRef } = await import(pathToFileURL(SECRET).href);

const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const T = { OP_SERVICE_ACCOUNT_TOKEN: DUMMY_TOKEN };
function fixture() {
  const s = scratch();
  cleanups.push(s.cleanup);
  const repo = makeRepo(s);
  return { s, repo };
}
const noLeak = (r, ...values) => { for (const v of [DUMMY_TOKEN, ...values]) assert.ok(!r.out.includes(v), 'output leaked a value'); };

describe('units', () => {
  test('parseEnvFile reads values as data', () => {
    const m = parseEnvFile('# c\nexport A=1\nB="two words # not a comment"\nC=three # comment\nD=\'$literal\'\nE="multi\nline"\nF="esc\\nape"\n');
    assert.deepEqual(Object.fromEntries(m), { A: '1', B: 'two words # not a comment', C: 'three', D: '$literal', E: 'multi\nline', F: 'esc\nape' });
  });
  test('mergeFields refuses foreign fields unless replace', () => {
    const item = { id: 'i', fields: [{ id: 'X', label: 'X', value: 'old' }, { id: 'Y', label: 'Y', value: 'o', section: { id: 'agent-secret' } }] };
    const a = mergeFields(item, [{ name: 'X', value: 'n' }, { name: 'Y', value: 'n' }, { name: 'Z', value: 'n' }]);
    assert.deepEqual(a.refused, ['X']);
    assert.equal(a.changed, 2);
    assert.equal(a.item.fields.find((f) => f.id === 'Z').section.id, 'agent-secret');
    assert.equal(mergeFields(item, [{ name: 'X', value: 'n' }], { replace: true }).refused.length, 0);
  });
  test('appendRef adds once and never rewrites a different line', () => {
    const s = scratch([]);
    cleanups.push(s.cleanup);
    const f = path.join(s.dir, '.env.op');
    fs.writeFileSync(f, 'A=op://agent-repos/demo-x-dev/A');
    assert.equal(appendRef(f, 'B', 'op://agent-repos/demo-x-dev/B'), 'added');
    assert.equal(appendRef(f, 'B', 'op://agent-repos/demo-x-dev/B'), 'present');
    assert.equal(appendRef(f, 'A', 'op://agent-repos/demo-y-dev/A'), 'conflict');
    assert.equal(fs.readFileSync(f, 'utf8'), 'A=op://agent-repos/demo-x-dev/A\nB=op://agent-repos/demo-x-dev/B\n');
    // The key is matched literally: a regex-special name never matches another line.
    fs.writeFileSync(f, 'AXB=op://x\n');
    assert.equal(appendRef(f, 'A.B', 'op://agent-repos/demo-x-dev/A.B'), 'added');
  });
});

describe('put', () => {
  test('creates the item, verifies it and appends the reference', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['put', 'demo-api-dev', 'API_KEY', '--repo', 'demo'], repo.wt, 'secret-value-1\n', T);
    assert.equal(r.status, 0, r.out);
    noLeak(r, 'secret-value-1');
    assert.match(r.stdout, /stored op:\/\/agent-repos\/demo-api-dev\/API_KEY/);
    const item = s.readState().op.items[0];
    assert.equal(item.category, 'API_CREDENTIAL');
    assert.deepEqual(item.tags, ['repo:demo', 'agent-created']);
    assert.deepEqual(item.fields[0], { id: 'API_KEY', label: 'API_KEY', type: 'CONCEALED', value: 'secret-value-1', section: { id: 'agent-secret' } });
    assert.equal(fs.readFileSync(path.join(repo.wt, '.env.op'), 'utf8'), 'API_KEY=op://agent-repos/demo-api-dev/API_KEY\n');
    const calls = s.calls('op');
    assert.ok(calls.every((c) => c.hasToken));
    assert.ok(calls.every((c) => !c.args.join(' ').includes('secret-value-1')), 'value never in argv');
    assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')), ['item get', 'item create', 'read --no-newline']);
  });

  test('without --repo the template is left alone', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['put', 'demo-api-dev', 'API_KEY'], repo.wt, 'v', T);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(repo.wt, '.env.op')), false);
  });

  test('refuses --env prod and -prod items (no override with --env dev)', () => {
    const { s, repo } = fixture();
    for (const args of [['put', 'demo-api-dev', 'K', '--env', 'prod'], ['put', 'demo-api-prod', 'K'], ['put', 'demo-api-prod', 'K', '--env', 'dev']]) {
      const r = secret(s, args, repo.wt, 'v', T);
      assert.equal(r.status, 2, r.out);
      assert.match(r.stderr, /production values never go into agent-repos/);
    }
    assert.equal(s.calls('op').length, 0);
  });

  test('itemPrefix in repo.json sets the required prefix', () => {
    const s = scratch();
    cleanups.push(s.cleanup);
    const repo = makeRepo(s, { config: { itemPrefix: 'dm' } });
    assert.equal(secret(s, ['put', 'demo-api-dev', 'K', '--repo', 'demo'], repo.wt, 'v', T).status, 2);
    const r = secret(s, ['put', 'dm-api-dev', 'K', '--repo', 'demo'], repo.wt, 'v', T);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(repo.wt, '.env.op'), 'utf8'), 'K=op://agent-repos/dm-api-dev/K\n');
  });

  test('refuses item names outside <repo>- when --repo is given', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['put', 'other-api-dev', 'K', '--repo', 'demo'], repo.wt, 'v', T);
    assert.equal(r.status, 2, r.out);
    assert.match(r.stderr, /start with demo-/);
    assert.equal(s.calls('op').length, 0);
  });

  test('refuses to overwrite a field it did not create unless --replace', () => {
    const { s, repo } = fixture();
    s.writeState((st) => { st.op.items.push({ id: 'i9', vault: 'agent-repos', title: 'demo-db-dev', fields: [{ id: 'DB_URL', label: 'DB_URL', type: 'CONCEALED', value: 'owner-value' }] }); });
    const r = secret(s, ['put', 'demo-db-dev', 'DB_URL'], repo.wt, 'new-value', T);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /refused/);
    assert.equal(s.readState().op.items[0].fields[0].value, 'owner-value');
    const ok = secret(s, ['put', 'demo-db-dev', 'DB_URL', '--replace'], repo.wt, 'new-value', T);
    assert.equal(ok.status, 0, ok.out);
    assert.equal(s.readState().op.items[0].fields[0].value, 'new-value');
    // Adding a new field to an existing item needs no --replace.
    const add = secret(s, ['put', 'demo-db-dev', 'DB_USER'], repo.wt, 'u', T);
    assert.equal(add.status, 0, add.out);
    assert.equal(s.readState().op.items[0].fields.length, 2);
  });

  test('a read-back mismatch fails', () => {
    const { s, repo } = fixture();
    s.writeState((st) => { st.op.corruptRead = true; });
    const r = secret(s, ['put', 'demo-api-dev', 'API_KEY'], repo.wt, 'v', T);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /verification failed/);
  });

  test('refuses a value from a terminal or empty stdin', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['put', 'demo-api-dev', 'API_KEY'], repo.wt, '', T);
    assert.equal(r.status, 2, r.out);
    assert.match(r.stderr, /empty value/);
  });

  test('no token: clear failure', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['put', 'demo-api-dev', 'API_KEY'], repo.wt, 'v');
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /no OP_SERVICE_ACCOUNT_TOKEN/);
  });
});

describe('import, ref, check', () => {
  function files(repo, map) {
    const env = path.join(repo.wt, 'scratch', 'old.env');
    write(env, 'API_KEY=a-1\nDB_URL="postgres://u:p@h/db"\nDEBUG=true\nUNMAPPED=x\nMULTI="l1\nl2"\n');
    const mapFile = path.join(repo.wt, 'scratch', 'map.json');
    write(mapFile, JSON.stringify(map));
    return { env, mapFile };
  }

  test('migrates, verifies, writes template lines, retires the source', () => {
    const { s, repo } = fixture();
    const { env, mapFile } = files(repo, { API_KEY: 'demo-api-dev', DB_URL: { item: 'demo-db-dev' }, MULTI: 'demo-db-dev', DEBUG: 'skip' });
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--retire-source'], repo.wt, undefined, T);
    assert.equal(r.status, 0, r.out);
    noLeak(r, 'a-1', 'postgres://u:p@h/db');
    assert.match(r.stdout, /migrated 3, skipped 2, mismatches 0/);
    const items = s.readState().op.items;
    assert.deepEqual(items.map((i) => i.title).sort(), ['demo-api-dev', 'demo-db-dev']);
    assert.equal(items.find((i) => i.title === 'demo-db-dev').fields.find((f) => f.label === 'MULTI').value, 'l1\nl2');
    const tpl = fs.readFileSync(path.join(repo.wt, '.env.op'), 'utf8');
    assert.match(tpl, /^API_KEY=op:\/\/agent-repos\/demo-api-dev\/API_KEY$/m);
    assert.match(tpl, /^DB_URL=op:\/\/agent-repos\/demo-db-dev\/DB_URL$/m);
    assert.equal(fs.existsSync(env), false);
    assert.ok(fs.existsSync(`${env}.pre-op`));
  });

  test('--retire-source never overwrites an existing .pre-op file', () => {
    const { s, repo } = fixture();
    const { env, mapFile } = files(repo, { API_KEY: 'demo-api-dev' });
    write(`${env}.pre-op`, 'EARLIER=keep\n');
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--retire-source'], repo.wt, undefined, T);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /old\.env\.pre-op already exists/);
    assert.equal(fs.readFileSync(`${env}.pre-op`, 'utf8'), 'EARLIER=keep\n');
    assert.ok(fs.existsSync(env));
  });

  test('--retire-source requires a git-ignored destination and makes it private', () => {
    const { s, repo } = fixture();
    const env = path.join(repo.wt, 'old.env');
    write(env, 'API_KEY=a-1\n');
    const mapFile = path.join(repo.wt, 'scratch', 'map.json');
    write(mapFile, JSON.stringify({ API_KEY: 'demo-api-dev' }));
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--retire-source'], repo.wt, undefined, T);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /would not be git-ignored/);
    assert.ok(fs.existsSync(env));
    const ok = files(repo, { API_KEY: 'demo-api-dev' });
    const r2 = secret(s, ['import', '--env', ok.env, '--map', ok.mapFile, '--retire-source', '--replace'], repo.wt, undefined, T);
    assert.equal(r2.status, 0, r2.out);
    if (!isWin) assert.equal(fs.statSync(`${ok.env}.pre-op`).mode & 0o777, 0o600);
  });

  test('refuses prod map entries before calling op', () => {
    const { s, repo } = fixture();
    const { env, mapFile } = files(repo, { API_KEY: 'demo-api-dev', DB_URL: { item: 'demo-db-dev', env: 'prod' } });
    const r = secret(s, ['import', '--env', env, '--map', mapFile], repo.wt, undefined, T);
    assert.equal(r.status, 2, r.out);
    assert.match(r.stderr, /production values never go into agent-repos/);
    assert.equal(s.calls('op').length, 0);
  });

  test('refuses foreign item names with --repo', () => {
    const { s, repo } = fixture();
    const { env, mapFile } = files(repo, { API_KEY: 'other-api-dev' });
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--repo', 'demo'], repo.wt, undefined, T);
    assert.equal(r.status, 2, r.out);
    assert.equal(s.calls('op').length, 0);
  });

  test('dry run calls no op', () => {
    const { s, repo } = fixture();
    const { env, mapFile } = files(repo, { API_KEY: 'demo-api-dev' });
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--dry-run'], repo.wt, undefined, T);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /would migrate 1 into 1 items/);
    assert.equal(s.calls('op').length, 0);
    assert.ok(fs.existsSync(env));
  });

  test('mismatches keep the source', () => {
    const { s, repo } = fixture();
    s.writeState((st) => { st.op.corruptRead = true; });
    const { env, mapFile } = files(repo, { API_KEY: 'demo-api-dev' });
    const r = secret(s, ['import', '--env', env, '--map', mapFile, '--retire-source'], repo.wt, undefined, T);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /migrated 0, skipped 4, mismatches 1/);
    assert.ok(fs.existsSync(env));
  });

  test('ref prints the reference', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['ref', 'demo-api-dev', 'API_KEY'], repo.wt);
    assert.equal(r.stdout.trim(), 'op://agent-repos/demo-api-dev/API_KEY');
  });

  test('check reports type and vault visibility only', () => {
    const { s, repo } = fixture();
    const r = secret(s, ['check'], repo.wt, undefined, T);
    assert.equal(r.status, 0, r.out);
    noLeak(r, 'team.example.com');
    assert.match(r.stdout, /account type: SERVICE_ACCOUNT/);
    assert.match(r.stdout, /vaults visible: 1; agent-repos: visible/);
    const miss = secret(s, ['check', '--vault', 'nope'], repo.wt, undefined, T);
    assert.equal(miss.status, 1);
  });
});
