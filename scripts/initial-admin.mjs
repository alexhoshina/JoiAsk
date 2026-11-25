import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword, validInitialAdminCredentials } from '../worker/password.mjs';

async function initialAdminSQL(username, password) {
  if (validInitialAdminCredentials(username, password)) {
    const text = value => "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
    return `INSERT INTO admins(username,password_hash,role)
      SELECT ${text(username)},${text(await hashPassword(password))},'super_admin' WHERE NOT EXISTS (SELECT 1 FROM admins);`;
  }
  // This check runs only in the first site transaction. An existing site's
  // deployment and a pre-provisioned administrator both ignore incomplete inputs.
  return `CREATE TABLE joiask_initial_admin_check (
    valid INTEGER CONSTRAINT "Set both JOIASK_INITIAL_ADMIN_USERNAME and JOIASK_INITIAL_ADMIN_PASSWORD with a nonblank username and a one-line password up to 4096 bytes" CHECK (valid=1)
  );
  INSERT INTO joiask_initial_admin_check SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM admins);
  DROP TABLE joiask_initial_admin_check;`;
}

export async function applySiteMigrations(configFile, config, db, cli, username, password) {
  const apply = file => cli.wrangler('d1', 'migrations', 'apply', 'DB', '--remote', '--force', '--config', file);
  if (!username && !password) return apply(configFile);
  const directory = await mkdtemp(path.join(tmpdir(), 'joiask-migrate-'));
  try {
    const sourceDir = db.migrations_dir || 'migrations';
    const dir = path.join(directory, 'migrations');
    await cp(path.resolve(path.dirname(configFile), sourceDir), dir, { recursive: true, dereference: true });
    const identity = await readFile(path.join(dir, '0002_identity.sql'), 'utf8');
    const admins = identity.match(/^CREATE TABLE IF NOT EXISTS admins\s*\([\s\S]*?^\);/m)?.[0];
    if (!admins) throw new Error('Administrator table definition missing from the identity migration.');
    // Wrangler commits each migration with its ledger entry. If 0001 has
    // already run, credentials are ignored even if 0002 has not yet run.
    await appendFile(path.join(dir, '0001_config.sql'), '\n' + admins + '\n' + await initialAdminSQL(username, password) + '\n');
    const target = { ...db, migrations_dir: 'migrations' };
    if (db.migrations_pattern) {
      const pattern = path.posix.relative(sourceDir.replaceAll('\\', '/'), db.migrations_pattern.replaceAll('\\', '/'));
      target.migrations_pattern = 'migrations/' + pattern;
    }
    const file = path.join(directory, 'wrangler.json');
    await writeFile(file, JSON.stringify({ name: config.name, account_id: config.account_id,
      compliance_region: config.compliance_region, d1_databases: [target] }), { mode: 0o600 });
    await apply(file);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
