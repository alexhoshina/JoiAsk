import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builtConfig, childEnvironment, deploymentName, finished, root, startNode, targetManifest, withDeployConfig, wrangler, wranglerBin,
} from './worker-cli.mjs';
import { applySiteMigrations } from './initial-admin.mjs';

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
  await finished(startNode(path.join(root,'scripts/build.mjs'),[]));
  await deployBuild(await builtConfig(),options);
}
