import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deployBuild } from '../../scripts/deploy.mjs';
import { childEnvironment, finished, startNode, wranglerBin } from '../../scripts/worker-cli.mjs';
import { verifyPassword } from '../../worker/password.mjs';

const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));
const source = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
const dbId = '65c7c263-8292-4264-8d04-effa83147c7c';
const usernameKey = 'JOIASK_INITIAL_ADMIN_USERNAME';
const passwordKey = 'JOIASK_INITIAL_ADMIN_PASSWORD';

async function precreateAdmins(sqlite) {
  const identity = await readFile(path.join(migrations, '0002_identity.sql'), 'utf8');
  sqlite.exec(identity.slice(0, identity.indexOf(';') + 1));
}

async function fixture(t, localMigration) {
  const directory = await mkdtemp(path.join(tmpdir(), 'joiask-deploy-owner-'));
  const configPath = path.join(directory, 'wrangler.json');
  const config = structuredClone(source);
  Object.assign(config.d1_databases[0], { database_id: dbId, migrations_dir: migrations });
  await writeFile(configPath, JSON.stringify(config));
  const sqlite = new DatabaseSync(':memory:');
  const original = [process.env[usernameKey], process.env[passwordKey]];
  const passwords = new Set();
  const transientMigrations = new Set();
  const calls = [];
  const output = [];
  let interruptAfter;
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));

  function setEnv(username, password) {
    if (username === undefined) delete process.env[usernameKey];
    else process.env[usernameKey] = username;
    if (password === undefined) delete process.env[passwordKey];
    else process.env[passwordKey] = password;
  }
  function checkSecrets(value) {
    for (const password of passwords) {
      assert.equal(value.includes(password), false, 'deployment exposed the plaintext fixture password');
      assert.equal(value.toLowerCase().includes(Buffer.from(password).toString('hex')), false, 'deployment exposed a hex-encoded fixture password');
    }
  }
  t.after(async () => {
    setEnv(...original);
    sqlite.close();
    try {
      checkSecrets(output.join('\n'));
      assert.deepEqual(await readdir(directory), ['wrangler.json']);
      for (const dir of transientMigrations) await assert.rejects(access(dir), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  function credentials(username, password) {
    setEnv(username, password);
    if (password) passwords.add(password);
  }
  credentials();

  // Exercise real project migration SQL transactionally. As in Wrangler,
  // a migration is recorded by filename only once its SQL has succeeded.
  async function apply(migrationDir, through) {
    sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const name of (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort()) {
      if (through && name > through) break;
      const sql = await readFile(path.join(migrationDir, name), 'utf8');
      checkSecrets(sql);
      if (sqlite.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(name)) continue;
      sqlite.exec('BEGIN');
      try {
        sqlite.exec(sql);
        sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      if (name === interruptAfter) {
        interruptAfter = undefined;
        throw new Error('Simulated interruption after a committed migration');
      }
    }
  }
  const cli = {
    findDatabase() { assert.fail('deployment must target the selected database'); },
    async wrangler(...args) {
      checkSecrets(JSON.stringify(args));
      const manifestPath = args[args.indexOf('--config') + 1];
      const manifest = await readFile(manifestPath, 'utf8');
      checkSecrets(manifest);
      assert.ok(!manifest.includes(usernameKey) && !manifest.includes(passwordKey), 'initial credentials must not be Worker bindings');
      const db = JSON.parse(manifest).d1_databases.find(item => item.binding === 'DB');
      assert.equal(db.database_id, dbId);
      if (args[0] === 'deploy') {
        calls.push(args.includes('--dry-run') ? 'dry-run' : 'deploy');
      } else if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') {
        assert.equal(args[3], 'DB');
        assert.ok(args.includes('--remote'));
        const migrationDir = path.resolve(path.dirname(manifestPath), db.migrations_dir);
        if (migrationDir !== migrations) transientMigrations.add(migrationDir);
        if (localMigration) await localMigration(manifestPath);
        else await apply(migrationDir);
        calls.push('migrations');
      } else assert.fail('unexpected deployment command ' + args.slice(0, 2).join(' '));
    },
  };
  return {
    sqlite, calls, credentials, checkSecrets, apply,
    stopAfter(name) { interruptAfter = name; },
    deploy: (dryRun = false) => deployBuild(configPath, { dryRun }, cli),
    accounts: () => sqlite.prepare('SELECT id,username,password_hash,role,session_version FROM admins ORDER BY id').all(),
  };
}

test('fresh deployment creates one login-compatible super administrator and redeploy cannot change it', async t => {
  const app = await fixture(t);
  const original = 'fixture-first-password-9234!';
  const other = 'fixture-replacement-secret-7302';
  const user = "operator's-account";
  app.credentials(user, original);
  await app.deploy();
  const first = app.accounts();
  assert.equal(first.length, 1);
  assert.equal(first[0].username, user);
  assert.equal(first[0].role, 'super_admin');
  assert.equal(first[0].session_version, 0);
  assert.equal(await verifyPassword(original, first[0].password_hash), true);
  app.credentials(user, other);
  await app.deploy();
  app.credentials('new-operator', other);
  await app.deploy();
  assert.deepEqual(app.accounts(), first);
  assert.equal(await verifyPassword(other, first[0].password_hash), false);
  app.sqlite.exec('DELETE FROM admins');
  await app.deploy();
  assert.deepEqual(app.accounts(), []);
});

test('an installation without bootstrap credentials stays closed even if its admin table is empty later', async t => {
  const app = await fixture(t);
  await app.deploy();
  assert.deepEqual(app.accounts(), []);
  app.credentials('later-user', 'fixture-late-bootstrap-1367');
  await app.deploy();
  assert.deepEqual(app.accounts(), []);
});

test('an existing administrator is never promoted or given a new password by deployment', async t => {
  const app = await fixture(t);
  // A pre-provisioned admins table may even predate Wrangler's migration ledger.
  await precreateAdmins(app.sqlite);
  app.sqlite.prepare("INSERT INTO admins(username,password_hash,role,session_version) VALUES(?,?,'admin',7)")
    .run('existing-user', 'original-stored-hash');
  const before = app.accounts();
  app.credentials(undefined, 'fixture-unpaired-password-3527');
  await app.deploy();
  assert.deepEqual(app.accounts(), before);
  app.credentials('existing-user', 'fixture-overwrite-secret-1672');
  await app.deploy();
  assert.deepEqual(app.accounts(), before);
});

test('a fresh site can initialize its first owner in a pre-provisioned empty admins table', async t => {
  const app = await fixture(t);
  await precreateAdmins(app.sqlite);
  app.credentials('new-operator', 'fixture-preexisting-table-1432');
  await app.deploy();
  const accounts = app.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'new-operator');
  assert.equal(accounts[0].role, 'super_admin');
  assert.equal(await verifyPassword('fixture-preexisting-table-1432', accounts[0].password_hash), true);
  assert.equal(app.sqlite.prepare('SELECT count(*) AS n FROM config').get().n, 1);
});

test('an existing site with only migration 0001 applied never acquires a bootstrap administrator', async t => {
  const app = await fixture(t);
  await app.apply(migrations, '0001_config.sql');
  assert.equal(app.sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='admins'").get().n, 0);
  app.sqlite.prepare('UPDATE config SET site_name=? WHERE id=1').run('preexisting installation');
  app.credentials('new-owner', 'fixture-upgrade-password-1902');
  await app.deploy();
  assert.deepEqual(app.accounts(), []);
  assert.equal(app.sqlite.prepare('SELECT site_name FROM config WHERE id=1').get().site_name, 'preexisting installation');
});

test('a deployment interrupted between the first two migrations resumes the original initialization', async t => {
  const app = await fixture(t);
  app.credentials('original-operator', 'fixture-interrupted-init-7123');
  app.stopAfter('0001_config.sql');
  await assert.rejects(app.deploy());
  assert.ok(!app.calls.includes('deploy'));
  assert.deepEqual(app.sqlite.prepare('SELECT name FROM d1_migrations').all().map(row => row.name), ['0001_config.sql']);
  const first = app.accounts();
  assert.equal(first.length, 1);
  assert.equal(first[0].username, 'original-operator');
  app.credentials();
  await app.apply(migrations);
  await app.deploy();
  assert.deepEqual(app.accounts(), first);
  assert.equal(await verifyPassword('fixture-interrupted-init-7123', first[0].password_hash), true);
});

test('concurrent attempts on one fresh database leave a single valid account', async t => {
  const app = await fixture(t);
  app.credentials('concurrent-operator', 'fixture-concurrent-password-6402');
  const results = await Promise.allSettled([app.deploy(), app.deploy()]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  const accounts = app.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'concurrent-operator');
  assert.equal(await verifyPassword('fixture-concurrent-password-6402', accounts[0].password_hash), true);
});

test('invalid credentials on a fresh deployment can be corrected without losing the first-install opportunity', async t => {
  const app = await fixture(t);
  const invalid = [[undefined, 'fixture-no-username-1392'], ['setup-admin', undefined],
    ['setup-admin', 'multiline-fixture\npassword'], ['setup-admin', 'x'.repeat(4097)]];
  for (const [user, password] of invalid) {
    app.credentials(user, password);
    await assert.rejects(app.deploy(), error => {
      app.checkSecrets(error.message);
      return true;
    });
    assert.ok(!app.calls.includes('deploy'));
  }
  app.credentials('setup-admin', 'fixture-eligible-password-8721');
  await app.deploy();
  const accounts = app.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'setup-admin');
  assert.equal(await verifyPassword('fixture-eligible-password-8721', accounts[0].password_hash), true);
  app.credentials(undefined, 'fixture-unused-password-8391');
  await app.deploy();
  assert.deepEqual(app.accounts(), accounts);
});

test('dry-run ignores bootstrap credentials and leaves the database untouched', async t => {
  const app = await fixture(t);
  app.credentials('dry-run-user', 'fixture-dry-run-password-5322');
  await app.deploy(true);
  app.credentials(undefined, 'fixture-incomplete-dry-run-3027');
  await app.deploy(true);
  assert.deepEqual(app.calls, ['dry-run', 'dry-run']);
  assert.deepEqual(app.sqlite.prepare('SELECT name FROM sqlite_schema WHERE type=?').all('table'), []);
});

test('build and Wrangler child processes cannot inherit the bootstrap variables', async t => {
  const app = await fixture(t);
  app.credentials('ci-operator', 'fixture-hidden-from-child-8147');
  const check = 'if (Object.keys(process.env).some(k => /^JOIASK_INITIAL_ADMIN_(USERNAME|PASSWORD)$/i.test(k))) process.exitCode = 1';
  await finished(startNode('-e', [check], {
    stdio: 'ignore', env: { [passwordKey.toLowerCase()]: 'fixture-case-insensitive-override-8626' },
  }));
});

test('Wrangler applies the generated administrator migration to an actual local D1', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'joiask-bootstrap-d1-'));
  t.after(() => rm(state, { recursive: true, force: true, maxRetries: 5 }));
  const password = 'fixture-wrangler-owner-2482';
  const app = await fixture(t, async file => {
    const local = ['--local', '--config', file, '--persist-to', state];
    function run(args) {
      const result = spawnSync(process.execPath, [wranglerBin, ...args], {
        env: childEnvironment({ WRANGLER_LOG_PATH: path.join(state, 'logs') }),
        windowsHide: true, encoding: 'utf8',
      });
      app.checkSecrets(result.stdout + result.stderr);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }
    run(['d1', 'migrations', 'apply', 'DB', ...local]);
    const response = run(['d1', 'execute', 'DB', ...local, '--json', '--command', 'SELECT username,password_hash,role FROM admins']);
    const owners = JSON.parse(response)[0].results;
    assert.equal(owners.length, 1);
    assert.equal(owners[0].username, 'local-d1-owner');
    assert.equal(owners[0].role, 'super_admin');
    assert.equal(await verifyPassword(password, owners[0].password_hash), true);
  });
  app.credentials('local-d1-owner', password);
  await app.deploy();
});
