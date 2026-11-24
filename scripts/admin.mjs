import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hashPassword } from '../worker/password.mjs';
import { deploymentName, root, targetDatabase } from './worker-cli.mjs';

const usage = 'Usage: node scripts/admin.mjs (--local | --remote) [--name WORKER] [--config PATH] [--persist-to PATH] (create | reset-password | promote) USERNAME';

function parse(args) {
  const positional = [], targets = [], options = [];
  let config = join(root,'wrangler.jsonc'), name, persist = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--local' || arg === '--remote') targets.push(arg);
    else if (arg === '--config' || arg === '--persist-to' || arg === '--name') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
      const value = args[++i];
      if (arg === '--config') config = resolve(value);
      else if (arg === '--name') name = value;
      else { persist = true; options.push(arg, resolve(value)); }
    } else positional.push(arg);
  }
  const [command, username] = positional;
  if (targets.length !== 1 || persist && targets[0] !== '--local' || name && targets[0] !== '--remote' || positional.length !== 2 ||
    !['create', 'reset-password', 'promote'].includes(command) || !username?.trim() || username.includes('\0')) throw new Error(usage);
  return { command, username, target: targets[0], options, config, name };
}

async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new Error('Supply the password on stdin through a protected prompt or password manager.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4098) throw new Error('Invalid password input.');
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!value || /[\r\n]/.test(value) || Buffer.byteLength(value) > 4096) throw new Error('Invalid password input.');
  return value;
}

function textLiteral(value) {
  return "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
}

async function run() {
  const { command, username, target, options, config, name } = parse(process.argv.slice(2));
  const account = textLiteral(username);
  const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  let sql;
  if (command === 'promote') {
    sql = `UPDATE admins SET session_version=session_version+(role<>'super_admin'), updated_at=CASE WHEN role<>'super_admin' THEN ${timestamp} ELSE updated_at END, role='super_admin' WHERE username=${account};`;
  } else {
    const hash = textLiteral(await hashPassword(await passwordFromStdin()));
    sql = command === 'create'
      ? `INSERT INTO admins(username,password_hash,role) VALUES (${account},${hash},'super_admin');`
      : `UPDATE admins SET password_hash=${hash},session_version=session_version+1,updated_at=${timestamp} WHERE username=${account};`;
  }
  // Fail the operation for absent users on both local execution and a remote, atomic D1 file import.
  sql += "\nSELECT json(CASE changes() WHEN 1 THEN 'true' ELSE 'account missing' END);\n";
  const directory = await mkdtemp(join(tmpdir(), 'joiask-admin-'));
  try {
    let configFile = config;
    if (target === '--remote') {
      const { unstable_readConfig } = await import('wrangler');
      const source = unstable_readConfig({config}, {useRedirectIfAvailable:false, hideWarnings:true});
      const worker = deploymentName(source,name);
      const db = targetDatabase(source,worker);
      // A fresh clone needs neither Vite output nor a previous deployment to
      // operate on the correct database. Keep account and jurisdiction settings.
      const remote = {name:worker, account_id:source.account_id, compliance_region:source.compliance_region, d1_databases:[db]};
      configFile = join(directory,'wrangler.json');
      await writeFile(configFile,JSON.stringify(remote),{mode:0o600,flag:'wx'});
    }
    const file = join(directory, 'operation.sql');
    await writeFile(file, sql, { mode: 0o600, flag: 'wx' });
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('wrangler/package.json');
    const cli = join(dirname(pkg), require(pkg).bin.wrangler);
    const run = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', target, ...options, '--config', configFile, '--file', file, '--json', '--yes'], {
      cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error' },
    });
    if (run.status !== 0) throw new Error('Administrator update failed. Check the target, migrations, account name and Cloudflare access.');
    console.log('Administrator account updated.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
