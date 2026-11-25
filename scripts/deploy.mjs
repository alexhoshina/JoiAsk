import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builtConfig, childEnvironment, deploymentName, root, runBuild, targetManifest, withDeployConfig, wrangler, wranglerBin,
} from './worker-cli.mjs';
import { hashPassword, validInitialAdminCredentials } from '../worker/password.mjs';

const usage = 'Usage: npm run deploy -- [--name WORKER] [--dry-run] [--secrets-file PATH]';
function parseOptions(args) {
  let dryRun = false, name, secrets;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if ((arg === '--name' || arg === '--secrets-file') && args[i+1] && !args[i+1].startsWith('--')) {
      const value = args[++i];
      if (arg === '--name') name = value;
      else secrets = path.resolve(value);
    } else throw new Error(usage);
  }
  return {dryRun,name,secrets};
}

function findDatabase(configFile, db) {
  const output = execFileSync(process.execPath, [wranglerBin, 'd1', 'list', '--json', '--config', configFile],
    { cwd: root, env: childEnvironment(), encoding: 'utf8', stdio: ['ignore','pipe','inherit'], maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(output).find(item => item.name === db.database_name)?.uuid;
}

// Applying migrations before the first deploy requires an actual database.
// Pin its UUID in the same transient manifest both remote commands consume.
async function resolveDatabase(configFile, db, cli) {
  if (db.database_id) return db.database_id;
  const existing = cli.findDatabase(configFile,db);
  if (existing) return existing;
  const jurisdiction = db.jurisdiction ? ['--jurisdiction',db.jurisdiction] : [];
  try {
    await cli.wrangler('d1','create',db.database_name,'--config',configFile,'--update-config=false',...jurisdiction);
  } catch (error) {
    // A simultaneous first deployment may have created this exact resource.
    const concurrent = cli.findDatabase(configFile,db);
    if (concurrent) return concurrent;
    throw error;
  }
  const created = cli.findDatabase(configFile,db);
  if (!created) throw new Error('Could not resolve the UUID for ' + db.database_name);
  return created;
}

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

export async function deployBuild(buildFile, {dryRun,name,secrets}, cli = {wrangler,findDatabase}) {
  const { JOIASK_INITIAL_ADMIN_USERNAME: username, JOIASK_INITIAL_ADMIN_PASSWORD: password } = process.env;
  const source = JSON.parse(await readFile(buildFile,'utf8'));
  const config = targetManifest(source,deploymentName(source,name));
  await withDeployConfig(buildFile,config,async file => {
    if (dryRun) {
      await cli.wrangler('deploy','--dry-run','--config',file);
      return;
    }
    const db = config.d1_databases.find(item => item.binding === 'DB');
    db.database_id = await resolveDatabase(file,db,cli);
    await writeFile(file,JSON.stringify(config),{mode:0o600});
    await applySiteMigrations(file, config, db, cli, username, password);
    await cli.wrangler('deploy','--config',file,...(secrets ? ['--secrets-file',secrets] : []));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  await runBuild();
  await deployBuild(await builtConfig(),options);
}
